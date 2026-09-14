import type { SqlDriver } from '../db/driver';
import { markStale, DERIVED_KINDS } from '../index/indexState';
import { downloadFile, safeName, stamp } from '../export/download';
import {
  ARCHIVE_TABLES, serialiseHeader, serialiseRow, serialiseFooter,
  parseArchive, rowsByTable, type ParsedArchive,
} from './archive';

/**
 * Backup — docs/08 Phase 1, and D9.
 *
 * "With no server and evictable browser storage, this is the only thing between
 * you and total loss." Which makes it worth being precise about what each half
 * actually protects against, because they are not the same thing:
 *
 *   - **The OPFS snapshot is automatic and weak.** It lives in the same origin
 *     storage as the database, so an eviction takes both. What it defends is
 *     everything else: a bad migration, a mistaken delete, a bug in this app.
 *   - **The exported file is durable and manual.** A browser will not write to
 *     the filesystem without a gesture, so this cannot be silent. The honest
 *     design is therefore not a promise of automatic safety — it is to keep
 *     count of how long it has been and say so plainly.
 *
 * Claiming "automatic backup" while only doing the first would be the most
 * dangerous kind of feature: one that makes a writer stop worrying about the
 * thing that can still destroy their novel.
 */

const SNAPSHOT_DIR = 'backups';
const KEEP_SNAPSHOTS = 5;
const LAST_EXPORT_KEY = 'lorescribe.last_export';

export interface ExportResult {
  text: string;
  rows: number;
  bytes: number;
  counts: Record<string, number>;
}

export async function exportProjectArchive(
  driver: SqlDriver, projectId: string, schemaVersion: number,
): Promise<ExportResult> {
  const title = await driver.query('SELECT title FROM project WHERE id = ?', [projectId], 'get');
  const projectTitle = String((title.rows as unknown[])[0] ?? 'Untitled');

  const counts: Record<string, number> = {};
  const bodies: string[] = [];
  const hashes: string[] = [];

  for (const spec of ARCHIVE_TABLES) {
    const { rows } = await driver.query(
      `SELECT * FROM ${spec.table} WHERE ${spec.scope}`, [projectId], 'all');
    const names = await columnNames(driver, spec.table);
    const asObjects = (rows as unknown[][]).map((r) => {
      const o: Record<string, unknown> = {};
      names.forEach((n, i) => { o[n] = r[i]; });
      return o;
    });
    if (asObjects.length) counts[spec.table] = asObjects.length;
    for (const row of asObjects) {
      const { line, hash } = serialiseRow(spec, row);
      bodies.push(line);
      hashes.push(hash);
    }
  }

  const text = [
    serialiseHeader({
      exportedAt: Date.now(), schemaVersion, projectId, projectTitle, counts,
    }),
    ...bodies,
    serialiseFooter(hashes),
  ].join('\n');

  return { text, rows: bodies.length, bytes: new Blob([text]).size, counts };
}

async function columnNames(driver: SqlDriver, table: string): Promise<string[]> {
  const { rows } = await driver.query(`PRAGMA table_info(${table})`, [], 'all');
  return (rows as unknown[][]).map((r) => String(r[1]));
}

export interface RestoreResult {
  applied: number;
  skipped: { table: string; id: string; reason: string }[];
  problems: ParsedArchive['problems'];
}

/**
 * Restore what the archive can give us.
 *
 * Rows are inserted table by table in export order, which satisfies foreign
 * keys, and a row that still fails is recorded and stepped over rather than
 * aborting the restore. Refusing the whole file because one row lost its parent
 * turns a partial loss into a total one — the thing the format exists to avoid.
 */
export async function restoreArchive(driver: SqlDriver, text: string): Promise<RestoreResult> {
  const archive = parseArchive(text);
  const byTable = rowsByTable(archive);
  const result: RestoreResult = { applied: 0, skipped: [], problems: archive.problems };

  for (const spec of ARCHIVE_TABLES) {
    const rows = byTable.get(spec.table);
    if (!rows?.length) continue;
    for (const row of rows) {
      const cols = Object.keys(row.data);
      if (!cols.length) { result.skipped.push({ table: spec.table, id: row.id, reason: 'no columns' }); continue; }
      const sql = `INSERT OR REPLACE INTO ${spec.table} (${cols.join(',')}) `
        + `VALUES (${cols.map(() => '?').join(',')})`;
      try {
        await driver.query(sql, cols.map((c) => row.data[c] ?? null), 'run');
        result.applied += 1;
      } catch (e) {
        result.skipped.push({
          table: spec.table, id: row.id,
          reason: (e as { message?: string })?.message ?? String(e),
        });
      }
    }
  }
  await markStale(driver, DERIVED_KINDS);
  return result;
}

/* ------------------------------------------------------------------ snapshots */

export interface SnapshotInfo { name: string; at: number; bytes: number }

async function snapshotDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SNAPSHOT_DIR, { create: true });
  } catch { return null; }
}

/** Keep a rolling set in OPFS. Cheap insurance against everything but eviction. */
export async function writeSnapshot(text: string): Promise<SnapshotInfo | null> {
  const dir = await snapshotDir();
  if (!dir) return null;
  const at = Date.now();
  const name = `lorescribe-${new Date(at).toISOString().replace(/[:.]/g, '-')}.lorescribe`;
  try {
    const file = await dir.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    await w.write(text);
    await w.close();
    await pruneSnapshots(dir);
    return { name, at, bytes: new Blob([text]).size };
  } catch { return null; }
}

async function pruneSnapshots(dir: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
  names.sort();                                   // ISO timestamps sort chronologically
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) {
    try { await dir.removeEntry(name); } catch { /* already gone */ }
  }
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const dir = await snapshotDir();
  if (!dir) return [];
  const out: SnapshotInfo[] = [];
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const f = await (await dir.getFileHandle(name)).getFile();
      out.push({ name, at: f.lastModified, bytes: f.size });
    }
  } catch { /* report what we got */ }
  return out.sort((a, b) => b.at - a.at);
}

export async function readSnapshot(name: string): Promise<string | null> {
  const dir = await snapshotDir();
  if (!dir) return null;
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch { return null; }
}

/* -------------------------------------------------------------- durable export */

/** Hand the file to the writer. Requires a gesture; that is the browser's rule. */
export function downloadArchive(text: string, projectTitle: string): void {
  // Named and handed over by the same helpers the Markdown export uses, so a
  // folder of backups sorts as one set rather than two conventions that drifted.
  downloadFile(text, `${safeName(projectTitle)}-${stamp()}.lorescribe`, 'application/x-ndjson');
  markExported();
}

export function markExported(at = Date.now()): void {
  try { localStorage.setItem(LAST_EXPORT_KEY, String(at)); } catch { /* private mode */ }
}

export function lastExportedAt(): number | null {
  try {
    const v = localStorage.getItem(LAST_EXPORT_KEY);
    return v ? Number(v) : null;
  } catch { return null; }
}

export const EXPORT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface BackupStatus {
  lastExportedAt: number | null;
  /** True when it has been long enough that the writer should be told. */
  stale: boolean;
  snapshots: SnapshotInfo[];
}

export async function backupStatus(now = Date.now()): Promise<BackupStatus> {
  const last = lastExportedAt();
  return {
    lastExportedAt: last,
    stale: last === null || now - last > EXPORT_STALE_AFTER_MS,
    snapshots: await listSnapshots(),
  };
}
