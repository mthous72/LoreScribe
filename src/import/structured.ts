import { emptyNode, type SourceDoc, type SourceNode, type SourceTable } from './source';

/**
 * CSV and JSON into the same document tree.
 *
 * Neither format has sections, so both lean on the other two shapes: a CSV is
 * one table, and a JSON object is fields for its scalars, child nodes for its
 * objects, and a table for any array of objects. That last rule is the one
 * worth having — an export from a spreadsheet or another tool is almost always
 * an array of records, and a record array is a grid whether or not it was
 * written as one.
 *
 * What is deliberately NOT done here is inferring meaning from key names. A
 * JSON file with a `characters` array does not become characters; it becomes a
 * table called "characters" that the writer maps. The rules that guess live in
 * `plan.ts` where they can be seen and overridden, and a parser that guessed
 * would be making the same decision somewhere nobody can reach it.
 */

/**
 * RFC 4180, including the parts people forget: a quoted field may contain the
 * delimiter, a newline, and a doubled quote meaning one quote.
 *
 * Hand-written because the alternative is a dependency for eighty lines, and
 * because the failure mode of a naive `split(',')` is silent — it produces a
 * table with the right shape and the wrong contents, which survives review.
 */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/\r\n?/gu, '\n');

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (source[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell.trim()); cell = ''; continue; }
    if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  // A trailing newline is punctuation, not an empty record.
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Tab or comma, whichever the first line has more of. Covers a .tsv named .csv. */
function delimiterOf(text: string): string {
  const first = text.slice(0, text.indexOf('\n') + 1 || undefined);
  return (first.match(/\t/gu) ?? []).length > (first.match(/,/gu) ?? []).length ? '\t' : ',';
}

export function parseCsv(path: string, text: string): SourceDoc {
  const rows = parseCsvRows(text, delimiterOf(text));
  const root = emptyNode('', 0, null);
  if (rows.length) {
    // The first row is a header when every cell is non-empty and no cell
    // repeats — the shape a header has. A file without one keeps all its rows.
    const first = rows[0]!;
    const header = first.every((c) => c !== '') && new Set(first).size === first.length
      && rows.length > 1;
    root.tables.push(header
      ? { columns: first, rows: rows.slice(1) }
      : { columns: [], rows });
  }
  return { path, format: 'csv', root };
}

/* -------------------------------------------------------------------- JSON */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const scalar = (v: Json): v is string | number | boolean | null =>
  v === null || typeof v !== 'object';

const show = (v: Json): string => (v === null ? '' : String(v));

/** An array of objects is a grid, whether or not it was written as one. */
function tableFrom(rows: { [key: string]: Json }[]): SourceTable {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return {
    columns,
    rows: rows.map((row) => columns.map((c) => {
      const v = row[c];
      return v === undefined ? '' : (scalar(v) ? show(v) : JSON.stringify(v));
    })),
  };
}

function build(id: string, depth: number, heading: string | null, value: Json): SourceNode {
  const node = emptyNode(id, depth, heading);
  if (scalar(value)) { node.text = show(value); return node; }

  if (Array.isArray(value)) {
    const objects = value.filter((v): v is { [key: string]: Json } =>
      v !== null && typeof v === 'object' && !Array.isArray(v));
    if (objects.length === value.length && objects.length > 0) {
      node.tables.push(tableFrom(objects));
    } else {
      node.text = value.map((v) => (scalar(v) ? show(v) : JSON.stringify(v))).join('\n');
    }
    return node;
  }

  for (const [key, child] of Object.entries(value)) {
    if (scalar(child)) {
      // An empty value is still a statement that the key exists, so it is kept
      // rather than dropped — a blank `status` is not the same as no status.
      node.fields.push({ key, value: show(child) });
      continue;
    }
    const at = node.children.length;
    node.children.push(build(id ? `${id}.${at}` : String(at), depth + 1, key, child));
  }
  return node;
}

export function parseJson(path: string, text: string): SourceDoc {
  const value = JSON.parse(text) as Json;
  const root = build('', 0, null, value);
  return { path, format: 'json', root };
}
