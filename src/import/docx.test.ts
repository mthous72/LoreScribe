import { describe, it, expect } from 'vitest';
import {
  parseDocx, readZipEntry, scanXml, unescapeXml, headingLevel, readDocumentXml, documentTree,
} from './docx';
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

/* ------------------------------------------------------- a zip, from scratch */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real zip: local headers, a central directory, and an end record. */
async function zip(files: Record<string, string>, store = false): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content);
    const body = store ? raw : await deflate(raw);
    const nameBytes = encoder.encode(name);

    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, store ? 0 : 8, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(10, store ? 0 : 8, true);
    ev.setUint32(16, crc32(raw), true);
    ev.setUint32(20, body.length, true);
    ev.setUint32(24, raw.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    directory.push(entry);
    offset += local.length;
  }

  const directorySize = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, directory.length, true);
  endView.setUint16(10, directory.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...directory, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

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
    const bytes = await zip({ 'a.txt': 'one', 'word/document.xml': 'two' });
    expect(new TextDecoder().decode((await readZipEntry(bytes, 'word/document.xml'))!)).toBe('two');
  });

  it('reads a stored entry as well as a deflated one', async () => {
    const bytes = await zip({ 'a.txt': 'plain' }, true);
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
