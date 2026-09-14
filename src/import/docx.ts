import { emptyNode, type SourceDoc, type SourceNode, type SourceTable } from './source';

/**
 * Word documents, without a dependency and without a DOM.
 *
 * A `.docx` is a zip holding `word/document.xml`. Both halves are done by hand
 * here, and for reasons rather than by preference:
 *
 * **The zip** is read with `DecompressionStream`, which the browser and Node
 * both have. A zip library would be a dependency carried into the bundle for a
 * feature most writers use once.
 *
 * **The XML** is read with the small scanner below rather than `DOMParser`,
 * which exists in the browser and not in Node. Using it would mean this file
 * took a different code path under test than in a writer's browser — the exact
 * arrangement `NodeSqlDriver`'s header warns about, where the tests cannot see
 * the bugs. The subset needed is tiny and Word's output is machine-generated
 * and regular.
 *
 * What Word calls a heading is a *style name*, not a structure: `Heading 1` is
 * a label on a paragraph, and a document can use `Title`, or a custom style, or
 * none at all. So the mapping is by style name where one is recognisable, and
 * everything else is prose — a document with no styles at all still imports,
 * as one section of text, which is the honest reading of it.
 */

/* --------------------------------------------------------------------- zip */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;

async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error(`unsupported compression method ${method}`);
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * One named file out of a zip.
 *
 * Read through the central directory rather than by scanning for local headers:
 * a local header does not reliably carry the compressed size (the streaming
 * writers Word uses put it in a trailing descriptor instead), so the sizes have
 * to come from the directory at the end.
 */
export async function readZipEntry(zip: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const text = new TextDecoder();

  let end = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === END_OF_DIRECTORY) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');

  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  for (let n = 0; n < entries; n++) {
    if (view.getUint32(at, true) !== CENTRAL_HEADER) throw new Error('damaged zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = text.decode(zip.subarray(at + 46, at + 46 + nameLength));

    if (name === wanted) {
      if (view.getUint32(localAt, true) !== LOCAL_HEADER) throw new Error('damaged zip entry');
      const localName = view.getUint16(localAt + 26, true);
      const localExtra = view.getUint16(localAt + 28, true);
      const from = localAt + 30 + localName + localExtra;
      return inflate(zip.subarray(from, from + compressed), method);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/* --------------------------------------------------------------------- XML */

export type XmlEvent =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/gu;

/** Enough XML for a Word document: tags, attributes, text, and nothing else. */
export function* scanXml(xml: string): Generator<XmlEvent> {
  for (let i = 0; i < xml.length;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const rest = xml.slice(i);
      if (rest) yield { kind: 'text', text: unescapeXml(rest) };
      return;
    }
    if (lt > i) yield { kind: 'text', text: unescapeXml(xml.slice(i, lt)) };

    // Comments, declarations and processing instructions carry nothing needed.
    if (xml.startsWith('<!--', lt)) { i = (xml.indexOf('-->', lt) + 3) || xml.length; continue; }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      i = (xml.indexOf('>', lt) + 1) || xml.length;
      continue;
    }

    const gt = xml.indexOf('>', lt);
    if (gt < 0) return;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (tag.startsWith('/')) { yield { kind: 'close', name: tag.slice(1).trim() }; continue; }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = body.split(/\s/u)[0]!;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    for (let m = ATTR.exec(body); m; m = ATTR.exec(body)) {
      attrs[m[1]!] = unescapeXml(m[2]!);
    }
    yield { kind: 'open', name, attrs, selfClosing };
  }
}

/* ------------------------------------------------------------------- Word */

/**
 * A Word style name to a heading level.
 *
 * `Title` is level 1 because that is what writers use it for, whatever Word
 * means by it. Anything unrecognised is not a heading — which is right: a
 * custom style is a style, and promoting it would invent structure the document
 * does not have.
 */
export function headingLevel(style: string | undefined): number | null {
  if (!style) return null;
  const normalised = style.toLowerCase().replace(/[\s_-]+/gu, '');
  if (normalised === 'title') return 1;
  const heading = /^heading([1-9])$/u.exec(normalised);
  return heading ? Number(heading[1]) : null;
}

interface Paragraph { style: string | undefined; text: string }

/** Paragraphs and tables, in order, out of `word/document.xml`. */
export function readDocumentXml(xml: string): (Paragraph | SourceTable)[] {
  const out: (Paragraph | SourceTable)[] = [];
  const stack: string[] = [];
  let paragraph: Paragraph | null = null;
  let table: SourceTable | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let inText = false;

  const inside = (tag: string) => stack.includes(tag);

  for (const event of scanXml(xml)) {
    if (event.kind === 'open') {
      if (!event.selfClosing) stack.push(event.name);
      switch (event.name) {
        case 'w:tbl': table = { columns: [], rows: [] }; break;
        case 'w:tr': row = []; break;
        case 'w:tc': cell = []; break;
        case 'w:p': paragraph = { style: undefined, text: '' }; break;
        case 'w:pStyle':
          if (paragraph) paragraph.style = event.attrs['w:val'];
          break;
        case 'w:t': inText = true; break;
        // A break or a tab inside a run is whitespace the writer put there.
        case 'w:br': if (paragraph) paragraph.text += '\n'; break;
        case 'w:tab': if (paragraph) paragraph.text += '\t'; break;
        default: break;
      }
      if (event.selfClosing && event.name === 'w:t') inText = false;
      continue;
    }

    if (event.kind === 'text') {
      if (inText && paragraph) paragraph.text += event.text;
      continue;
    }

    stack.pop();
    switch (event.name) {
      case 'w:t': inText = false; break;
      case 'w:p':
        if (paragraph) {
          if (cell) cell.push(paragraph.text);
          else if (!inside('w:tbl')) out.push(paragraph);
          paragraph = null;
        }
        break;
      case 'w:tc':
        if (row && cell) row.push(cell.join('\n').trim());
        cell = null;
        break;
      case 'w:tr':
        if (table && row) table.rows.push(row);
        row = null;
        break;
      case 'w:tbl':
        if (table) {
          // Word has no notion of a header row, so the first one is taken as
          // the header when it could be one — the same reading a person gives it.
          const first = table.rows[0];
          if (first && table.rows.length > 1 && first.every((c) => c !== '')
            && new Set(first).size === first.length) {
            table.columns = first;
            table.rows = table.rows.slice(1);
          }
          out.push(table);
        }
        table = null;
        break;
      default: break;
    }
  }
  return out;
}

export function documentTree(path: string, parts: (Paragraph | SourceTable)[]): SourceDoc {
  const root = emptyNode('', 0, null);
  const open: SourceNode[] = [root];
  let current = root;
  let paragraphs: string[] = [];

  const flush = () => {
    const body = paragraphs.join('\n\n').trim();
    if (body) current.text = current.text ? `${current.text}\n\n${body}` : body;
    paragraphs = [];
  };

  for (const part of parts) {
    if ('columns' in part) { flush(); current.tables.push(part); continue; }

    const level = headingLevel(part.style);
    if (level !== null && part.text.trim()) {
      flush();
      while (open.length > 1 && open[open.length - 1]!.depth >= level) open.pop();
      const parent = open[open.length - 1]!;
      const node = emptyNode(
        parent.id ? `${parent.id}.${parent.children.length}` : String(parent.children.length),
        level, part.text.trim(),
      );
      parent.children.push(node);
      open.push(node);
      current = node;
      continue;
    }

    // The same key/value reading Markdown gets, because a writer who typed
    // `Want: the throne` in Word meant exactly what they meant in Markdown.
    const field = /^\s*([A-Za-z][A-Za-z0-9 '’-]{0,31})\s*[:：]\s+(.+)$/u.exec(part.text);
    if (field && field[1]!.split(/\s+/u).length <= 3) {
      flush();
      current.fields.push({ key: field[1]!.trim(), value: field[2]!.trim() });
      continue;
    }
    if (part.text.trim()) paragraphs.push(part.text.trim());
  }
  flush();
  return { path, format: 'docx', root };
}

export async function parseDocx(path: string, bytes: Uint8Array): Promise<SourceDoc> {
  const xml = await readZipEntry(bytes, 'word/document.xml');
  if (!xml) throw new Error('no word/document.xml — is this really a .docx?');
  return documentTree(path, readDocumentXml(new TextDecoder().decode(xml)));
}
