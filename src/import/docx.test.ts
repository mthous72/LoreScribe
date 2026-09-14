import { describe, it, expect } from 'vitest';
import {
  parseDocx, readZipEntry, scanXml, unescapeXml, headingLevel, readDocumentXml, documentTree,
} from './docx';
import { writeZip } from '../export/zip';
import { walk } from './source';

/**
 * Word documents.
 *
 * The zip is built here rather than committed as a binary fixture, for two
 * reasons: D14 means no file that came from anywhere real, and a fixture nobody
 * can read is a fixture nobody can fix when it breaks. Building it also proves
 * the reader against a genuinely deflated entry rather than a stored one, which
 * is the path a real `.docx` takes.
 */

/* --------------------------------------------------------------- fixtures */

/**
 * Built with the real zip writer rather than a second one living in this file.
 *
 * D14 rules out a binary fixture that came from anywhere real, and a fixture
 * nobody can read is one nobody can fix. Using `writeZip` also means the reader
 * below is proved against the writer this app actually ships, instead of
 * against a test-only implementation that could drift from it.
 */
const zip = (files: Record<string, string>) =>
  writeZip(Object.entries(files).map(([path, content]) => ({ path, content })));

const p = (style: string | null, text: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}`
  + `<w:r><w:t>${text}</w:t></w:r></w:p>`;

const DOCUMENT = `<?xml version="1.0"?><w:document><w:body>
${p('Heading1', 'Ilva')}
${p(null, 'She keeps the seal &amp; the gate.')}
${p('Heading2', 'Arc')}
${p(null, 'Want: the throne.')}
<w:tbl>
  <w:tr><w:tc>${p(null, 'Fact')}</w:tc><w:tc>${p(null, 'Ilva')}</w:tc></w:tr>
  <w:tr><w:tc>${p(null, 'She is the heir')}</w:tc><w:tc>${p(null, 'yes')}</w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;

/* ------------------------------------------------------------------- tests */

describe('the zip reader', () => {
  it('finds an entry through the central directory and inflates it', async () => {
    // Through the directory rather than by scanning local headers: a streaming
    // writer leaves the compressed size out of the local header entirely.
    // Long and repetitive so the entry is genuinely deflated — a short one is
    // stored, and would prove nothing about inflate.
    const long = 'the harbour was empty. '.repeat(200);
    const bytes = await zip({ 'a.txt': 'one', 'word/document.xml': long });
    expect(bytes.length).toBeLessThan(long.length);
    expect(new TextDecoder().decode((await readZipEntry(bytes, 'word/document.xml'))!)).toBe(long);
  });

  it('reads a stored entry as well as a deflated one', async () => {
    // Deflate makes a tiny file bigger, so the writer stores it instead. Both
    // methods have to come back out.
    const bytes = await zip({ 'a.txt': 'plain' });
    expect(new TextDecoder().decode((await readZipEntry(bytes, 'a.txt'))!)).toBe('plain');
  });

  it('says nothing is there rather than throwing, for a missing name', async () => {
    expect(await readZipEntry(await zip({ 'a.txt': 'x' }), 'b.txt')).toBeNull();
  });

  it('refuses something that is not a zip at all', async () => {
    await expect(readZipEntry(new TextEncoder().encode('hello'), 'a'))
      .rejects.toThrow(/not a zip/u);
  });
});

describe('the XML scanner', () => {
  it('reads tags, attributes and text', () => {
    const events = [...scanXml('<a x="1">hi<b/></a>')];
    expect(events).toEqual([
      { kind: 'open', name: 'a', attrs: { x: '1' }, selfClosing: false },
      { kind: 'text', text: 'hi' },
      { kind: 'open', name: 'b', attrs: {}, selfClosing: true },
      { kind: 'close', name: 'a' },
    ]);
  });

  it('skips declarations and comments', () => {
    expect([...scanXml('<?xml version="1.0"?><!-- note --><a/>')].map((e) => e.kind))
      .toEqual(['open']);
  });

  it('unescapes the entities Word actually writes', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &#39; &#x2014;'))
      .toBe('a & b <c> "d" \' —');
  });
});

describe('Word styles', () => {
  it('maps heading styles to levels, however they are spelled', () => {
    expect(headingLevel('Heading1')).toBe(1);
    expect(headingLevel('heading 3')).toBe(3);
    expect(headingLevel('Title')).toBe(1);
  });

  it('does not promote a custom style into a heading', () => {
    // A custom style is a style. Promoting it would invent structure the
    // document does not have.
    expect(headingLevel('CharacterName')).toBeNull();
    expect(headingLevel(undefined)).toBeNull();
  });
});

describe('a whole document', () => {
  it('nests by heading style, reads fields and reads tables', async () => {
    const doc = await parseDocx('ilva.docx', await zip({ 'word/document.xml': DOCUMENT }));
    const nodes = [...walk(doc.root)].map(({ node }) => node);
    const ilva = nodes.find((n) => n.heading === 'Ilva')!;
    const arc = nodes.find((n) => n.heading === 'Arc')!;

    expect(doc.format).toBe('docx');
    expect(ilva.text).toBe('She keeps the seal & the gate.');
    expect(arc.depth).toBe(2);
    // The same key/value reading Markdown gets: a writer who typed
    // `Want: the throne` in Word meant what they meant in Markdown.
    expect(arc.fields).toEqual([{ key: 'Want', value: 'the throne.' }]);
    expect(arc.tables[0]).toEqual({ columns: ['Fact', 'Ilva'], rows: [['She is the heir', 'yes']] });
  });

  it('imports a document with no styles at all as one section of prose', async () => {
    // The honest reading of it. Refusing, or inventing headings, would both be
    // worse than the plain truth that the document has no structure.
    const plain = `<w:document><w:body>${p(null, 'One.')}${p(null, 'Two.')}</w:body></w:document>`;
    const doc = documentTree('x.docx', readDocumentXml(plain));
    expect(doc.root.children).toEqual([]);
    expect(doc.root.text).toBe('One.\n\nTwo.');
  });

  it('says so plainly when the file is not a Word document', async () => {
    await expect(parseDocx('x.docx', await zip({ 'a.txt': 'x' })))
      .rejects.toThrow(/is this really a \.docx/u);
  });
});
