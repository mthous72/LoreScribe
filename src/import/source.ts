/**
 * What a document looks like before any of it means anything.
 *
 * Every parser — Markdown, Word, JSON, CSV — produces this and nothing else, so
 * the mapping layer and the apply layer are written once and each new format is
 * a parser rather than a redesign. That is the whole reason this file exists
 * separately from the parsers: the moment one of them starts emitting entities
 * instead of sections, the assumption about what a document *is* has been made
 * inside a parser where nobody can see it or change it.
 *
 * Three shapes carry almost everything a story bible keeps, and they are the
 * three this representation has:
 *
 *  - **Sections.** Heading hierarchy. A character file, a reference note.
 *  - **Fields.** `Want: keep the door` — the key/value lines that make a
 *    template a template, and a Word "Heading 4" run, and a JSON object's keys.
 *  - **Tables.** A grid. The single highest-value shape in a bible: a
 *    "who knows what" table is a `fact` down the rows and a `fact_knowledge`
 *    across the columns, which is very nearly this schema already.
 *
 * Nothing here knows what a character is.
 */

export type SourceFormat = 'markdown' | 'text' | 'docx' | 'json' | 'csv';

/** A key/value line. `Want: keep the door.` */
export interface SourceField {
  key: string;
  value: string;
}

/** A grid. `columns` may be empty when the source had no header row. */
export interface SourceTable {
  columns: string[];
  rows: string[][];
}

export interface SourceNode {
  /**
   * Stable within its document — the path of child indices, `'1.0.2'`.
   *
   * Positional rather than random so that re-importing an edited file lands on
   * the same node, and a mapping the writer made by hand survives a reparse.
   */
  id: string;
  /** 0 for the document root, then the heading level. */
  depth: number;
  heading: string | null;
  /** Prose directly under this heading, excluding every child section. */
  text: string;
  fields: SourceField[];
  tables: SourceTable[];
  children: SourceNode[];
}

export interface SourceDoc {
  /** Where it came from, relative to whatever the writer handed over. */
  path: string;
  format: SourceFormat;
  root: SourceNode;
}

export function emptyNode(id: string, depth: number, heading: string | null = null): SourceNode {
  return { id, depth, heading, text: '', fields: [], tables: [], children: [] };
}

/** Every node, depth first, each with the headings above it. */
export function* walk(
  node: SourceNode, ancestors: SourceNode[] = [],
): Generator<{ node: SourceNode; ancestors: SourceNode[] }> {
  yield { node, ancestors };
  for (const child of node.children) yield* walk(child, [...ancestors, node]);
}

/** A node's own prose plus everything beneath it, which is what a dossier is. */
export function subtreeText(node: SourceNode): string {
  const parts: string[] = [];
  for (const { node: n } of walk(node)) {
    if (n !== node && n.heading) parts.push(n.heading);
    if (n.text) parts.push(n.text);
    for (const f of n.fields) parts.push(`${f.key}: ${f.value}`);
  }
  return parts.join('\n\n').trim();
}

/** True when a node carries nothing at all — a heading with no content under it. */
export function isEmpty(node: SourceNode): boolean {
  return !node.text && node.fields.length === 0 && node.tables.length === 0
    && node.children.length === 0;
}

/**
 * A field key, normalised for matching: lowercased, punctuation dropped.
 *
 * So that `Want`, `**Want**` and `WANT:` are one key. Matching is done on this
 * and never on the raw text, because a bible written over two years does not
 * capitalise the same word the same way twice.
 */
export function fieldKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

/** Look a field up by its normalised key. */
export function field(node: SourceNode, ...keys: string[]): string | null {
  const want = new Set(keys.map(fieldKey));
  for (const f of node.fields) if (want.has(fieldKey(f.key))) return f.value;
  return null;
}
