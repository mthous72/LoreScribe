import type { SqlDriver } from './driver';

/**
 * Driver conformance suite.
 *
 * Written against the SqlDriver INTERFACE, never against an implementation.
 * Only one driver exists today; the Capacitor one arrives in Phase 6, by which
 * point there is a migration history and real data, and "the abstraction was
 * the wrong shape" would mean migrating a live database across two engines.
 * This suite is the mechanism that makes Phase 6 an implementation rather than
 * an excavation — R4 in docs/15 §1.
 *
 * The engines genuinely differ, so the cases below are chosen where they differ:
 * row shape, transaction semantics, foreign-key enforcement, multi-statement
 * SQL, and journal mode.
 */

export interface Case { name: string; pass: boolean; detail?: string }

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function runConformance(driver: SqlDriver): Promise<Case[]> {
  const cases: Case[] = [];
  const check = async (name: string, fn: () => Promise<string | undefined>) => {
    try {
      const detail = await fn();
      cases.push({ name, pass: true, ...(detail ? { detail } : {}) });
    } catch (e) {
      cases.push({ name, pass: false, detail: (e as Error).message ?? String(e) });
    }
  };
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

  await driver.exec('DROP TABLE IF EXISTS _conf_child');
  await driver.exec('DROP TABLE IF EXISTS _conf');
  await driver.exec(`
    CREATE TABLE _conf (id INTEGER PRIMARY KEY, s TEXT, n REAL, z INTEGER);
    CREATE TABLE _conf_child (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES _conf(id));
  `);

  // Drizzle's sqlite-proxy contract: rows are POSITIONAL ARRAYS of column
  // values, not row objects. Getting this wrong produces data that looks
  // plausible and is wrong, which is the worst failure mode available.
  await check('all() returns an array of positional arrays', async () => {
    await driver.query('INSERT INTO _conf (id,s,n,z) VALUES (?,?,?,?)', [1, 'a', 1.5, 10], 'run');
    await driver.query('INSERT INTO _conf (id,s,n,z) VALUES (?,?,?,?)', [2, 'b', 2.5, 20], 'run');
    const { rows } = await driver.query('SELECT id,s,n,z FROM _conf ORDER BY id', [], 'all');
    assert(Array.isArray(rows) && rows.length === 2, 'expected 2 rows');
    assert(Array.isArray(rows[0]), 'row must be an array, not an object');
    assert(eq(rows[0], [1, 'a', 1.5, 10]), `row shape wrong: ${JSON.stringify(rows[0])}`);
    return '[[1,"a",1.5,10], …]';
  });

  await check('get() returns ONE row as a flat array, not an array of rows', async () => {
    const { rows } = await driver.query('SELECT id,s FROM _conf WHERE id = ?', [2], 'get');
    assert(eq(rows, [2, 'b']), `expected [2,"b"], got ${JSON.stringify(rows)}`);
    return '[2,"b"]';
  });

  await check('get() on no match returns an empty array, not null', async () => {
    const { rows } = await driver.query('SELECT id FROM _conf WHERE id = ?', [999], 'get');
    assert(eq(rows, []), `expected [], got ${JSON.stringify(rows)}`);
    return undefined;
  });

  await check('run() returns no rows', async () => {
    const { rows } = await driver.query('UPDATE _conf SET s = ? WHERE id = ?', ['a2', 1], 'run');
    assert(eq(rows, []), `expected [], got ${JSON.stringify(rows)}`);
    return undefined;
  });

  await check('NULL round-trips as null, not undefined or empty string', async () => {
    await driver.query('INSERT INTO _conf (id,s,n,z) VALUES (?,?,?,?)', [3, null, null, null], 'run');
    const { rows } = await driver.query('SELECT s,n,z FROM _conf WHERE id = ?', [3], 'get');
    assert(eq(rows, [null, null, null]), `got ${JSON.stringify(rows)}`);
    return undefined;
  });

  await check('integers and reals keep their types', async () => {
    const { rows } = await driver.query('SELECT z, n FROM _conf WHERE id = ?', [1], 'get');
    const [z, n] = rows as [number, number];
    assert(Number.isInteger(z), `z should be an integer, got ${typeof z} ${z}`);
    assert(!Number.isInteger(n) && typeof n === 'number', `n should be a real, got ${n}`);
    return undefined;
  });

  await check('text with quotes, newlines and unicode survives binding', async () => {
    const nasty = `it's "quoted"\n\ttabbed — em-dash · 日本語 · ümlaut`;
    await driver.query('INSERT INTO _conf (id,s) VALUES (?,?)', [4, nasty], 'run');
    const { rows } = await driver.query('SELECT s FROM _conf WHERE id = ?', [4], 'get');
    assert((rows as string[])[0] === nasty, 'text did not round-trip');
    return undefined;
  });

  await check('foreign keys are ENFORCED (per-connection pragma, every open)', async () => {
    let threw = false;
    try {
      await driver.query('INSERT INTO _conf_child (id,parent) VALUES (?,?)', [1, 424242], 'run');
    } catch { threw = true; }
    assert(threw, 'FK violation was not rejected — PRAGMA foreign_keys is off');
    return undefined;
  });

  await check('batch() is atomic: a failure rolls the whole batch back', async () => {
    const before = (await driver.query('SELECT COUNT(*) FROM _conf', [], 'get')).rows as number[];
    let threw = false;
    try {
      await driver.batch([
        { sql: 'INSERT INTO _conf (id,s) VALUES (?,?)', params: [90, 'ok'] },
        { sql: 'INSERT INTO _conf (id,s) VALUES (?,?)', params: [1, 'duplicate pk'] },
      ]);
    } catch { threw = true; }
    assert(threw, 'duplicate primary key did not raise');
    const after = (await driver.query('SELECT COUNT(*) FROM _conf', [], 'get')).rows as number[];
    assert(before[0] === after[0], `batch left ${after[0]! - before[0]!} rows behind — not atomic`);
    return 'rolled back cleanly';
  });

  await check('exec() runs multi-statement SQL (prepare() would take only the first)', async () => {
    await driver.exec(`
      CREATE TABLE _conf_multi_a (x INTEGER);
      CREATE TABLE _conf_multi_b (y INTEGER);
      INSERT INTO _conf_multi_a VALUES (1);
    `);
    const { rows } = await driver.query(
      `SELECT COUNT(*) FROM sqlite_master WHERE name IN ('_conf_multi_a','_conf_multi_b')`, [], 'get');
    assert((rows as number[])[0] === 2, 'only some statements ran');
    await driver.exec('DROP TABLE _conf_multi_a; DROP TABLE _conf_multi_b;');
    return undefined;
  });

  await check('user_version round-trips (the migration source of truth)', async () => {
    const original = ((await driver.query('PRAGMA user_version', [], 'get')).rows as number[])[0]!;
    await driver.exec('PRAGMA user_version = 4242');
    const read = ((await driver.query('PRAGMA user_version', [], 'get')).rows as number[])[0]!;
    assert(read === 4242, `expected 4242, got ${read}`);
    await driver.exec(`PRAGMA user_version = ${original}`);
    return undefined;
  });

  await check('FTS5 is compiled in', async () => {
    await driver.exec(`CREATE VIRTUAL TABLE _conf_fts USING fts5(body)`);
    await driver.query('INSERT INTO _conf_fts (body) VALUES (?)', ['the grey warden rides'], 'run');
    const { rows } = await driver.query(`SELECT COUNT(*) FROM _conf_fts WHERE _conf_fts MATCH ?`, ['warden'], 'get');
    assert((rows as number[])[0] === 1, 'FTS5 match failed');
    await driver.exec('DROP TABLE _conf_fts');
    return undefined;
  });

  await check('journal mode is readable and is one we chose', async () => {
    const mode = String(((await driver.query('PRAGMA journal_mode', [], 'get')).rows as string[])[0]);
    // `memory` is fast and unsafe: its rollback journal lives in RAM, so a crash
    // mid-transaction can corrupt the file. Never a shipping mode. docs/16.
    assert(mode.toLowerCase() !== 'memory', 'journal_mode=memory is not durable enough to ship');
    assert(mode.toLowerCase() !== 'off', 'journal_mode=off has no rollback journal at all');
    return mode;
  });

  await check('integrity_check passes', async () => {
    const { rows } = await driver.query('PRAGMA integrity_check', [], 'get');
    assert((rows as string[])[0] === 'ok', `integrity_check said: ${JSON.stringify(rows)}`);
    return undefined;
  });

  await driver.exec('DROP TABLE IF EXISTS _conf_child; DROP TABLE IF EXISTS _conf;');
  return cases;
}
