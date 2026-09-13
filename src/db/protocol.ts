// Worker RPC protocol.
//
// We define our own rather than using `sqlite3Worker1Promiser`: that API was
// deprecated 2026-04-15 and its author describes it as "too fragile, too
// imperformant, and too limited for any non-toy software". See docs/15 §7.

/** Drizzle's sqlite-proxy method names. `values` and `all` differ only downstream. */
export type SqlMethod = 'run' | 'all' | 'values' | 'get';

export interface OpenRequest {
  /** Must be absolute: sahpool silently mishandles relative paths. */
  path: string;
  vfsName: string;
  /** Pool capacity is a FILE COUNT, default 6. See docs/15 §7. */
  minimumCapacity: number;
  /** Wipes the pool. Test-only. */
  clearOnInit?: boolean;
}

export interface Diagnostics {
  vfsName: string;
  /** Read back, never assumed — `journal_mode` reports rather than throws. */
  journalMode: string;
  lockingMode: string;
  tempStore: string;
  foreignKeys: number;
  pageSize: number;
  userVersion: number;
  capacity: number;
  fileCount: number;
  sqliteVersion: string;
  /** Bytes, via the pool's own accounting where available. */
  dbBytes: number | null;
}

export type Req =
  | { id: number; kind: 'open'; req: OpenRequest }
  | { id: number; kind: 'exec'; sql: string }
  | { id: number; kind: 'query'; sql: string; params: unknown[]; method: SqlMethod }
  | { id: number; kind: 'batch'; items: { sql: string; params: unknown[] }[]; wrap?: boolean }
  | { id: number; kind: 'journal'; mode: string; synchronous?: string }
  | { id: number; kind: 'diagnostics' }
  | { id: number; kind: 'pause' }
  | { id: number; kind: 'unpause' }
  | { id: number; kind: 'close' };

export type Res =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; code?: string } };

/** Why an open failed, in terms the UI can act on. */
export type OpenFailure =
  | 'held-by-another-tab'
  | 'opfs-unavailable'
  | 'pool-full'
  | 'unknown';

/** Distributive Omit, so a union member's own fields survive. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ReqBody = DistOmit<Req, 'id'>;
