import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { SqlDriver } from './driver';
import type { SqlMethod, Diagnostics } from './protocol';

/**
 * `SqlDriver` over Node's built-in SQLite, for tests.
 *
 * Not a third engine and not shipped: nothing in `src/app` or `src/db/client`
 * imports it, so it never reaches a bundle — `node:sqlite` would fail to
 * resolve in a browser if it did, which is a loud failure rather than a quiet
 * one.
 *
 * It exists because the interesting bugs in the rebuild path are SQL bugs. Four
 * of eighteen export specs once named a column that does not exist and the
 * symptom was the whole backup throwing at run time; the same class of mistake
 * in a rebuilder would corrupt derived data instead of failing loudly. Testing
 * against the real `db/schema.sql` is what catches it.
 */
export class NodeSqlDriver implements SqlDriver {
  readonly engine = 'node:sqlite';
  constructor(private readonly db: DatabaseSync) {}

  /** A fresh in-memory database with the shipped schema and seed migration. */
  static open(): NodeSqlDriver {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync('db/schema.sql', 'utf8'));
    db.exec(readFileSync('db/migrations/002_seed_entity_types.sql', 'utf8'));
    return new NodeSqlDriver(db);
  }

  async exec(sql: string): Promise<void> { this.db.exec(sql); }

  async query(sql: string, params: unknown[], method: SqlMethod): Promise<{ rows: unknown[] }> {
    const stmt = this.db.prepare(sql);
    // Positional arrays, matching the worker protocol and drizzle-orm's
    // sqlite-proxy contract — an object per row would pass every test here and
    // break every caller in the app.
    stmt.setReturnArrays(true);
    const bound = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
    if (method === 'run') { stmt.run(...bound); return { rows: [] }; }
    const rows = stmt.all(...bound) as unknown[];
    return method === 'get' ? { rows: (rows[0] as unknown[]) ?? [] } : { rows };
  }

  async batch(items: { sql: string; params: unknown[] }[], wrap = false): Promise<void> {
    if (wrap) this.db.exec('BEGIN');
    try {
      for (const item of items) await this.query(item.sql, item.params, 'run');
      if (wrap) this.db.exec('COMMIT');
    } catch (e) {
      if (wrap) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async setJournalMode(mode: string): Promise<{ journalMode: string; lockingMode: string }> {
    return { journalMode: mode, lockingMode: 'normal' };
  }

  async diagnostics(): Promise<Diagnostics> {
    throw new Error('diagnostics is a browser-storage concern; not modelled here');
  }

  async close(): Promise<void> { this.db.close(); }
}
