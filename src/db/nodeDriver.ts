import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver } from './driver';
import { migrate } from './migrate';
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

  /**
   * A fresh in-memory database, brought up through the real migrator.
   *
   * Deliberately not applying the SQL files by hand. It used to, and left
   * `user_version` at 0 while the tables existed — a state no real database is
   * ever in, and one that hid the fact that these fixtures were not going
   * through the code that upgrades a writer's database. A test driver that
   * builds its schema differently from production is a test driver that cannot
   * see migration bugs.
   */
  static async open(): Promise<NodeSqlDriver> {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const driver = new NodeSqlDriver(db);
    await migrate(driver);
    return driver;
  }

  async exec(sql: string): Promise<void> { this.db.exec(sql); }

  async query(sql: string, params: unknown[], method: SqlMethod): Promise<{ rows: unknown[] }> {
    const stmt = this.db.prepare(sql);
    // Positional arrays, matching the worker protocol — an object per row would
    // pass every test here and break every caller in the app.
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
