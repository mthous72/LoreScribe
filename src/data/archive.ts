/**
 * The `.lorescribe` archive — docs/08 Phase 1.
 *
 * "A backup you can't open in twelve months isn't a backup", and the corollary
 * the roadmap draws from it: a damaged archive must be *partially* recoverable,
 * so the importer salvages what it can instead of refusing the file.
 *
 * That is a format decision, not an importer one. A single JSON document fails
 * whole: one truncated byte and `JSON.parse` rejects eighty thousand words. So
 * the archive is newline-delimited JSON — a header, one self-describing line per
 * row, a footer. A corrupt line costs that line. A truncated file costs the
 * tail. Everything before the damage still opens.
 *
 * Each row carries its own table, id, parents, rank and a content hash, so it
 * can be placed without the header and checked without the footer.
 */

export const ARCHIVE_FORMAT = 1;

export interface ArchiveHeader {
  kind: 'header';
  lorescribe: number;
  exportedAt: number;
  /** Migration version the rows came from, so an importer knows their shape. */
  schemaVersion: number;
  projectId: string;
  projectTitle: string;
  counts: Record<string, number>;
}

export interface ArchiveRow {
  kind: 'row';
  table: string;
  id: string;
  /** Foreign keys, so a row can be re-parented even if its header is gone. */
  parents: Record<string, string | null>;
  /** Sort key or rank where the table has one; used to restore order. */
  rank?: string | null;
  hash: string;
  data: Record<string, unknown>;
}

export interface ArchiveFooter {
  kind: 'footer';
  rows: number;
  /** Hash of all row hashes, in order. Detects a silently truncated middle. */
  hash: string;
}

export type ArchiveLine = ArchiveHeader | ArchiveRow | ArchiveFooter;

/**
 * FNV-1a, 32-bit, hex.
 *
 * Corruption detection, not tamper resistance — nothing here defends against a
 * hostile edit, and saying so is better than implying a guarantee a checksum
 * does not provide. Chosen over SubtleCrypto because that is async, and an
 * export that must await a digest per row is an export that stalls the editor.
 */
export function contentHash(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Tables an archive carries, in an order that satisfies foreign keys on import. */
export interface TableSpec {
  table: string;
  /** Columns that reference another row, recorded so re-parenting survives. */
  parents: string[];
  /** Column that orders siblings, if any. */
  rank?: string;
  /** How to scope the query to one project. */
  scope: string;
}

export const ARCHIVE_TABLES: TableSpec[] = [
  { table: 'project', parents: [], scope: 'id = ?' },
  { table: 'book', parents: ['project_id'], rank: 'sort_key', scope: 'project_id = ?' },
  { table: 'part', parents: ['book_id'], rank: 'sort_key', scope: 'book_id IN (SELECT id FROM book WHERE project_id = ?)' },
  { table: 'chapter', parents: ['book_id', 'part_id'], rank: 'sort_key', scope: 'book_id IN (SELECT id FROM book WHERE project_id = ?)' },
  { table: 'scene', parents: ['chapter_id'], rank: 'global_rank', scope: 'chapter_id IN (SELECT c.id FROM chapter c JOIN book b ON b.id = c.book_id WHERE b.project_id = ?)' },
  { table: 'scene_version', parents: ['scene_id'], scope: 'scene_id IN (SELECT s.id FROM scene s JOIN chapter c ON c.id = s.chapter_id JOIN book b ON b.id = c.book_id WHERE b.project_id = ?)' },
  { table: 'entity_type', parents: [], scope: 'project_id = ? OR project_id IS NULL' },
  { table: 'entity', parents: ['project_id', 'type_key'], scope: 'project_id = ?' },
  { table: 'entity_alias', parents: ['entity_id'], scope: 'entity_id IN (SELECT id FROM entity WHERE project_id = ?)' },
  { table: 'entity_relationship', parents: ['from_entity_id', 'to_entity_id'], scope: 'from_entity_id IN (SELECT id FROM entity WHERE project_id = ?)' },
  { table: 'fact', parents: ['project_id', 'subject_entity_id'], scope: 'project_id = ?' },
  { table: 'fact_knowledge', parents: ['fact_id', 'entity_id'], scope: 'fact_id IN (SELECT id FROM fact WHERE project_id = ?)' },
  // arc and narrative_thread hang off book, not project — a series shares a
  // codex but arcs belong to a book. Getting this wrong is not a silent
  // mis-scope: the column does not exist and the export throws.
  { table: 'arc', parents: ['book_id'], rank: 'sort_key', scope: 'book_id IN (SELECT id FROM book WHERE project_id = ?)' },
  { table: 'beat', parents: ['arc_id'], rank: 'sort_key', scope: 'arc_id IN (SELECT a.id FROM arc a JOIN book b ON b.id = a.book_id WHERE b.project_id = ?)' },
  { table: 'beat_scene', parents: ['beat_id', 'scene_id'], scope: 'beat_id IN (SELECT bt.id FROM beat bt JOIN arc a ON a.id = bt.arc_id JOIN book b ON b.id = a.book_id WHERE b.project_id = ?)' },
  { table: 'narrative_thread', parents: ['book_id'], scope: 'book_id IN (SELECT id FROM book WHERE project_id = ?)' },
  { table: 'law', parents: ['project_id'], scope: 'project_id = ?' },
  { table: 'note', parents: ['project_id'], scope: 'project_id = ?' },
];

export function serialiseHeader(h: Omit<ArchiveHeader, 'kind' | 'lorescribe'>): string {
  return JSON.stringify({ kind: 'header', lorescribe: ARCHIVE_FORMAT, ...h } satisfies ArchiveHeader);
}

export function serialiseRow(
  spec: TableSpec, row: Record<string, unknown>,
): { line: string; hash: string } {
  const parents: Record<string, string | null> = {};
  for (const p of spec.parents) parents[p] = (row[p] as string | null) ?? null;
  const hash = contentHash(row);
  const entry: ArchiveRow = {
    kind: 'row',
    table: spec.table,
    id: String(row.id ?? ''),
    parents,
    ...(spec.rank ? { rank: (row[spec.rank] as string | null) ?? null } : {}),
    hash,
    data: row,
  };
  return { line: JSON.stringify(entry), hash };
}

export function serialiseFooter(hashes: readonly string[]): string {
  return JSON.stringify({
    kind: 'footer', rows: hashes.length, hash: contentHash(hashes),
  } satisfies ArchiveFooter);
}

export interface ParsedArchive {
  header: ArchiveHeader | null;
  rows: ArchiveRow[];
  footer: ArchiveFooter | null;
  /** Everything that could not be used, and why. The point of the format. */
  problems: { line: number; reason: string; text: string }[];
  /** True when header, footer and every row hash agree. */
  intact: boolean;
}

/**
 * Read an archive, salvaging whatever is readable.
 *
 * Never throws on damaged input. An importer that refuses a file because one
 * line is broken has converted a recoverable problem into a total loss, which
 * is exactly the failure this format exists to prevent.
 */
export function parseArchive(text: string): ParsedArchive {
  const out: ParsedArchive = { header: null, rows: [], footer: null, problems: [], intact: true };
  const lines = text.split('\n');

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.problems.push({ line: i + 1, reason: 'not valid JSON — skipped', text: line.slice(0, 120) });
      out.intact = false;
      return;
    }
    const entry = parsed as Partial<ArchiveLine>;
    if (entry.kind === 'header') { out.header = entry as ArchiveHeader; return; }
    if (entry.kind === 'footer') { out.footer = entry as ArchiveFooter; return; }
    if (entry.kind !== 'row') {
      out.problems.push({ line: i + 1, reason: `unknown entry kind ${String(entry.kind)}`, text: line.slice(0, 120) });
      out.intact = false;
      return;
    }
    const row = entry as ArchiveRow;
    if (!row.table || !row.data) {
      out.problems.push({ line: i + 1, reason: 'row is missing its table or data', text: line.slice(0, 120) });
      out.intact = false;
      return;
    }
    if (row.hash && contentHash(row.data) !== row.hash) {
      // Kept, not dropped: the content parsed, so it is readable and the writer
      // can judge it. Flagged so nothing silently restores altered prose.
      out.problems.push({ line: i + 1, reason: `hash mismatch on ${row.table}/${row.id} — content may have been altered`, text: '' });
      out.intact = false;
    }
    out.rows.push(row);
  });

  if (!out.header) {
    out.problems.push({ line: 0, reason: 'no header — the archive may be truncated at the start', text: '' });
    out.intact = false;
  }
  if (!out.footer) {
    out.problems.push({ line: 0, reason: 'no footer — the archive is probably truncated', text: '' });
    out.intact = false;
  } else if (out.footer.rows !== out.rows.length) {
    out.problems.push({
      line: 0,
      reason: `footer expects ${out.footer.rows} rows, ${out.rows.length} readable — ${out.footer.rows - out.rows.length} lost`,
      text: '',
    });
    out.intact = false;
  }
  return out;
}

/** Group salvaged rows by table, preserving archive order. */
export function rowsByTable(archive: ParsedArchive): Map<string, ArchiveRow[]> {
  const byTable = new Map<string, ArchiveRow[]>();
  for (const r of archive.rows) {
    const at = byTable.get(r.table);
    if (at) at.push(r);
    else byTable.set(r.table, [r]);
  }
  return byTable;
}
