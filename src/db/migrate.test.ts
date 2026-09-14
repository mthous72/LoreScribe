import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { NodeSqlDriver } from './nodeDriver';
import { migrate } from './migrate';

/**
 * Migrating a database that already exists.
 *
 * Every other test in this repository creates a FRESH database, which is how a
 * real bug reached a real device: `db/schema.sql` IS migration 001, doc 15 R8
 * declared it mutable "since there is no installed base to protect", and two
 * commits edited it in place — renaming `project_lock` to `session_lock` and
 * fixing the fact views. The installed base already existed: the app had been
 * deployed and used on a phone during Phase 0. `migrate()` skips everything at
 * or below `user_version`, so that database stayed at 2 and never saw either
 * edit. It opened, migrated successfully, and failed on
 * `no such table: session_lock`.
 *
 * The suite could not have caught it. Not a missing test — a missing PATH.
 * These run the old shape forward.
 */

/** The schema exactly as the deployed Phase 0 build wrote it. */
function phase0Database(): NodeSqlDriver {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('tests/fixtures/schema-phase0.sql', 'utf8'));
  db.exec(readFileSync('db/migrations/002_seed_entity_types.sql', 'utf8'));
  // What migrate() left behind at the time: both migrations applied.
  db.exec('PRAGMA user_version = 2');
  return new NodeSqlDriver(db);
}

/** Every object SQLite holds, normalised so whitespace and comments cannot lie. */
async function structure(driver: NodeSqlDriver): Promise<string[]> {
  const { rows } = await driver.query(
    `SELECT type, name, IFNULL(sql, '') FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`, [], 'all');
  return (rows as unknown[][]).map((r) => {
    const sql = String(r[2])
      .replace(/--[^\n]*/g, ' ')          // comments are not structure
      .replace(/\s+/g, ' ')
      .trim();
    return `${r[0]}:${r[1]}:${sql}`;
  });
}

describe('a database from an older build', () => {
  it('reproduces the reported failure before migrating', async () => {
    const driver = phase0Database();
    await expect(driver.query('SELECT * FROM session_lock', [], 'all'))
      .rejects.toThrow(/no such table: session_lock/);
  });

  it('has session_lock after migrating, which is the bug report', async () => {
    const driver = phase0Database();
    const result = await migrate(driver);
    expect(result.from).toBe(2);
    expect(result.applied.map((a) => a.name)).toEqual(['repair_schema_drift']);
    await expect(driver.query('SELECT * FROM session_lock', [], 'all')).resolves.toBeDefined();
  });

  /**
   * The guard that makes this unrepeatable.
   *
   * Edit db/schema.sql without a migration and a fresh database gets the change
   * while a migrated one does not — so the two structures diverge and this
   * fails. It does not need to know what was edited.
   */
  it('ends up structurally identical to a fresh database', async () => {
    const fresh = await NodeSqlDriver.open();
    await migrate(fresh);
    const upgraded = phase0Database();
    await migrate(upgraded);
    expect(await structure(upgraded)).toEqual(await structure(fresh));
  });

  it('keeps the writer’s work through the repair', async () => {
    const driver = phase0Database();
    await driver.batch([
      { sql: 'INSERT INTO project (id,title,created_at,updated_at) VALUES (\'p1\',\'Ashfall\',1,1)', params: [] },
      { sql: `INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at)
              VALUES ('b1','p1','One','a0',1,1)`, params: [] },
      { sql: `INSERT INTO chapter (id,book_id,title,sort_key,created_at,updated_at)
              VALUES ('c1','b1','First','a0',1,1)`, params: [] },
      { sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,content_text,
                created_at,updated_at)
              VALUES ('s1','c1','Arrival','a0','a0','The council met at dawn.',1,1)`, params: [] },
    ], true);

    await migrate(driver);

    const { rows } = await driver.query('SELECT content_text FROM scene', [], 'all');
    expect(rows).toEqual([['The council met at dawn.']]);
  });

  it('fixes the fact view that silently returned nothing', async () => {
    const driver = phase0Database();
    await migrate(driver);
    await driver.batch([
      { sql: 'INSERT INTO project (id,title,created_at,updated_at) VALUES (\'p1\',\'Ashfall\',1,1)', params: [] },
      { sql: `INSERT INTO entity (id,project_id,type_key,name,created_at,updated_at)
              VALUES ('e1','p1','character','Ilva',1,1)`, params: [] },
      { sql: `INSERT INTO fact (id,project_id,subject_entity_id,predicate,object_text,statement,
                created_at,updated_at)
              VALUES ('f1','p1','e1','eye_colour','grey','Ilva has grey eyes.',1,1)`, params: [] },
      { sql: `INSERT INTO fact (id,project_id,subject_entity_id,predicate,object_text,statement,
                created_at,updated_at)
              VALUES ('f2','p1','e1','eye_colour','green','Ilva has green eyes.',1,1)`, params: [] },
    ], true);

    // Two literal facts that disagree. Under the old AND this returned nothing,
    // which reads exactly like "no contradictions".
    const { rows } = await driver.query('SELECT fact_a, fact_b FROM v_fact_conflicts', [], 'all');
    expect(rows).toEqual([['f1', 'f2']]);
  });
});

describe('a fresh database', () => {
  it('is unchanged by the repair — it is a no-op there', async () => {
    const driver = await NodeSqlDriver.open();
    const before = await structure(driver);
    await migrate(driver);
    expect(await structure(driver)).toEqual(before);
  });

  it('applies every migration and lands on the current version', async () => {
    const db = new DatabaseSync(':memory:');
    const driver = new NodeSqlDriver(db);
    const result = await migrate(driver);
    expect(result.from).toBe(0);
    expect(result.to).toBe(3);
    expect(result.applied.map((a) => a.name))
      .toEqual(['init', 'seed_entity_types', 'repair_schema_drift']);
  });
});

describe('re-running', () => {
  it('is a no-op the second time, at any starting version', async () => {
    const driver = phase0Database();
    await migrate(driver);
    const after = await structure(driver);
    const again = await migrate(driver);
    expect(again.applied).toEqual([]);
    expect(await structure(driver)).toEqual(after);
  });
});
