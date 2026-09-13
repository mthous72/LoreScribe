/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Req, Res, SqlMethod, OpenRequest, Diagnostics } from './protocol';

// The VFS lives here and nowhere else: createSyncAccessHandle() exists only in
// dedicated workers. Not the main thread, not shared workers, not service
// workers. See docs/15 §7.

type Stmt = {
  bind(values: unknown[]): Stmt;
  step(): boolean;
  get(target: unknown[]): unknown[];
  reset(alsoClearBinds?: boolean): Stmt;
  finalize(): void;
};
type AnyDb = {
  exec(opts: unknown): unknown;
  prepare(sql: string): Stmt;
  selectValue(sql: string): unknown;
  close(): void;
};
type PoolUtil = {
  OpfsSAHPoolDb: new (path: string) => AnyDb;
  getCapacity(): number;
  getFileCount(): number;
  reserveMinimumCapacity(n: number): Promise<void>;
  pauseVfs(): void;
  unpauseVfs(): Promise<unknown>;
  isPaused(): boolean;
};

let sqlite3: any = null;
let pool: PoolUtil | null = null;
let db: AnyDb | null = null;
let vfsName = '';

/**
 * Prepared-statement cache.
 *
 * Not an optimisation so much as a correction: re-preparing on every call put
 * bulk insert at 539 rows/s against a 5,000 target, because the corpus loader
 * issues ~20,000 statements and every one of them was compiled from scratch.
 * SQL text is the cache key; statements are reset (binds cleared) on reuse.
 */
const stmtCache = new Map<string, Stmt>();

function prepared(sql: string): Stmt {
  const hit = stmtCache.get(sql);
  if (hit) return hit.reset(true);
  const s = db!.prepare(sql);
  stmtCache.set(sql, s);
  return s;
}

function clearStmtCache(): void {
  for (const s of stmtCache.values()) { try { s.finalize(); } catch { /* already gone */ } }
  stmtCache.clear();
}

function run(sql: string, params: unknown[]): void {
  const s = prepared(sql);
  if (params.length) s.bind(params);
  while (s.step()) { /* drain any rows a DML..RETURNING might produce */ }
  s.reset(true);
}

/** Rows come back as positional arrays — the shape drizzle sqlite-proxy demands. */
function rows(sql: string, params: unknown[]): unknown[][] {
  const s = prepared(sql);
  if (params.length) s.bind(params);
  const out: unknown[][] = [];
  while (s.step()) out.push(s.get([]));
  s.reset(true);
  return out;
}

function pragma(name: string): unknown {
  return db!.selectValue(`PRAGMA ${name}`);
}

/**
 * Pragmas live here, never in the schema: they are per-connection, they are
 * order-sensitive, and the two engines land in different journal modes.
 * docs/15 §3a.
 */
function applyPragmas(): void {
  // Per-connection. Must be set on EVERY open, which is precisely why a
  // one-time migration could never have done this correctly.
  db!.exec('PRAGMA foreign_keys = ON');

  // The pragma that actually earns its place on sahpool, and not for speed:
  // temp files consume pool slots, and the pool is a fixed file count.
  db!.exec('PRAGMA temp_store = MEMORY');

  // Deliberately NOT enabling WAL. It is possible since SQLite 3.47 via
  // `locking_mode=exclusive` first, but sahpool is single-connection by
  // construction, so WAL's concurrency benefit is unavailable by definition and
  // sqlite.org claims only that it "may" help slightly. Measure before adopting.
}

/**
 * Journal mode, applied in the ONE order that works.
 *
 * WAL on an OPFS VFS requires `locking_mode=exclusive` set immediately after
 * opening, before anything else touches the handle — SQLite has no shared-memory
 * primitives in WASM, and exclusive locking is the documented escape hatch
 * (3.47+). `journal_mode` then REPORTS the mode it actually gave you rather than
 * failing, so we return the readback and never assume. docs/15 §3a.
 */
function applyJournalMode(mode: string, synchronous?: string): { journalMode: string; lockingMode: string } {
  if (mode.toLowerCase() === 'wal') db!.exec('PRAGMA locking_mode = exclusive');
  db!.exec(`PRAGMA journal_mode = ${mode}`);
  if (synchronous) db!.exec(`PRAGMA synchronous = ${synchronous}`);
  return {
    journalMode: String(pragma('journal_mode')),
    lockingMode: String(pragma('locking_mode')),
  };
}

async function open(req: OpenRequest): Promise<Diagnostics> {
  if (!sqlite3) sqlite3 = await sqlite3InitModule();

  // This is where a second tab fails — at install, before any database is
  // opened — and the result (success OR failure) is cached for the life of the
  // page. docs/15 §3c.
  pool = (await sqlite3.installOpfsSAHPoolVfs({
    name: req.vfsName,
    clearOnInit: req.clearOnInit ?? false,
  })) as PoolUtil;
  vfsName = req.vfsName;

  // Capacity is a FILE COUNT, default 6 — "only large enough for one or two
  // databases and their temp files". Overflow surfaces as SQLITE_CANTOPEN,
  // which reads like "can't open that file" and means "the pool is full".
  // Persistent across sessions, so this is a one-time raise, not per-boot churn.
  if (pool.getCapacity() < req.minimumCapacity) {
    await pool.reserveMinimumCapacity(req.minimumCapacity);
  }

  db = new pool.OpfsSAHPoolDb(req.path); // absolute path required
  applyPragmas();
  return diagnostics();
}

function diagnostics(): Diagnostics {
  const pageSize = Number(pragma('page_size') ?? 0);
  const pageCount = Number(pragma('page_count') ?? 0);
  return {
    vfsName,
    journalMode: String(pragma('journal_mode')), // read back, never assumed
    lockingMode: String(pragma('locking_mode')),
    tempStore: String(pragma('temp_store')),
    foreignKeys: Number(pragma('foreign_keys')),
    pageSize,
    userVersion: Number(pragma('user_version')),
    capacity: pool?.getCapacity() ?? 0,
    fileCount: pool?.getFileCount() ?? 0,
    sqliteVersion: String(sqlite3?.version?.libVersion ?? 'unknown'),
    dbBytes: pageSize && pageCount ? pageSize * pageCount : null,
  };
}

function query(sql: string, params: unknown[], method: SqlMethod): { rows: unknown[] } {
  if (method === 'run') {
    run(sql, params);
    return { rows: [] };
  }
  const r = rows(sql, params);
  // `get` returns a single row (one positional array), not an array of rows.
  return method === 'get' ? { rows: r[0] ?? [] } : { rows: r };
}

async function handle(m: Req): Promise<unknown> {
  switch (m.kind) {
    case 'open':
      return open(m.req);
    case 'exec':
      // Multi-statement SQL needs exec(); prepare() consumes only the first
      // statement. Schema bootstrap therefore bypasses Drizzle entirely.
      // DDL can invalidate prepared statements, so the cache goes with it.
      clearStmtCache();
      db!.exec(m.sql);
      return null;
    case 'query':
      return query(m.sql, m.params, m.method);
    case 'batch': {
      // wrap=false lets the caller span many round-trips in ONE transaction:
      // in `delete` journal mode each commit creates, fsyncs and deletes a
      // rollback journal, so transaction count dominates bulk throughput.
      const wrap = m.wrap !== false;
      if (wrap) db!.exec('BEGIN');
      try {
        for (const it of m.items) run(it.sql, it.params);
        if (wrap) db!.exec('COMMIT');
      } catch (e) {
        if (wrap) { try { db!.exec('ROLLBACK'); } catch { /* already unwound */ } }
        throw e;
      }
      return null;
    }
    case 'journal':
      return applyJournalMode(m.mode, m.synchronous);
    case 'diagnostics':
      return diagnostics();
    case 'pause':
      // Throws if any handle is still open, so the close has to be real.
      clearStmtCache();
      db?.close();
      db = null;
      pool!.pauseVfs();
      return null;
    case 'unpause':
      await pool!.unpauseVfs();
      return null;
    case 'close':
      clearStmtCache();
      db?.close();
      db = null;
      return null;
  }
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const m = ev.data;
  try {
    const value = await handle(m);
    (self as unknown as Worker).postMessage({ id: m.id, ok: true, value } satisfies Res);
  } catch (e) {
    const err = e as { name?: string; message?: string; resultCode?: number };
    (self as unknown as Worker).postMessage({
      id: m.id,
      ok: false,
      error: {
        name: err?.name ?? 'Error',
        message: err?.message ?? String(e),
        code: err?.resultCode != null ? String(err.resultCode) : undefined,
      },
    } satisfies Res);
  }
};
