import type { Diagnostics, SqlMethod, OpenFailure } from './protocol';

/**
 * The one interface both engines implement: sqlite-wasm over OPFS on the web,
 * @capacitor-community/sqlite on Android (Phase 6).
 *
 * Two drivers, not one, and deliberately so. The available simplification was
 * to use the Capacitor plugin on both platforms — but its web implementation
 * holds the whole database in RAM via sql.js and a committed transaction is not
 * durable until the app calls saveToStore(), while native persists
 * automatically. The same repository code, run both ways, would lose data on
 * exactly one of them. See D18.
 *
 * The conformance suite in tests/ runs against this interface rather than
 * either implementation, so Phase 6 is "make the second driver pass it".
 */
export interface SqlDriver {
  readonly engine: string;
  exec(sql: string): Promise<void>;
  query(sql: string, params: unknown[], method: SqlMethod): Promise<{ rows: unknown[] }>;
  batch(items: { sql: string; params: unknown[] }[], wrap?: boolean): Promise<void>;
  setJournalMode(mode: string, synchronous?: string): Promise<{ journalMode: string; lockingMode: string }>;
  diagnostics(): Promise<Diagnostics>;
  close(): Promise<void>;
}

export class SqlOpenError extends Error {
  constructor(readonly reason: OpenFailure, readonly detail: { name: string; message: string }) {
    super(detail.message);
    this.name = 'SqlOpenError';
  }
}

/** Map a raw install/open failure onto something the UI can act on. */
export function classifyOpenFailure(name: string, message: string): OpenFailure {
  // The second tab's VFS install rejects with the browser's own exception,
  // rethrown unmodified by the pool. docs/15 §3c.
  if (name === 'NoModificationAllowedError') return 'held-by-another-tab';
  if (/lock|already active|another browsing context/i.test(message)) return 'held-by-another-tab';
  if (/SAH pool is full/i.test(message)) return 'pool-full';
  if (/OPFS|SyncAccessHandle|not detected/i.test(message)) return 'opfs-unavailable';
  return 'unknown';
}
