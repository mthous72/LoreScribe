import { runSpike, type SpikeResult } from './measure';
import { WorkerSqlDriver } from '../db/client';
import { migrate } from '../db/migrate';
import { runConformance, type Case } from '../db/conformance';
import type { SqlOpenError } from '../db/driver';

// The surface Playwright drives. It lives in the shipped bundle deliberately:
// the same entry points are what the /diagnostics route uses, so the tests
// exercise the real code path rather than a parallel one built for testing.

declare global {
  interface Window {
    runSpike: typeof runSpike;
    spikeResult?: SpikeResult;
    /** Test surface: open the VFS without generating a corpus. */
    openOnly: (vfsName: string, clearOnInit?: boolean) => Promise<unknown>;
    /** Test surface: hold the VFS open, returning a handle to release it. */
    holdOpen: (vfsName: string) => Promise<unknown>;
    /** Test surface: reopen after a kill and count what survived. */
    reopenAndCount: (vfsName: string, table: string) => Promise<unknown>;
    /** Test surface: release the held driver, with or without the VFS handoff. */
    releaseHeld: (usePause: boolean) => Promise<unknown>;
    /** Test surface: the driver conformance suite (Gate B). */
    runConformance: (vfsName: string) => Promise<Case[]>;
    /** Test surface: sqlite_master after migration, for schema equivalence. */
    schemaDump: (vfsName: string) => Promise<string[]>;
    /** Test surface: does a database in this journal mode survive a reopen? */
    reopenUnderJournalMode: (vfsName: string, mode: string) => Promise<unknown>;
    __held?: WorkerSqlDriver;
  }
}
window.runSpike = runSpike;

window.openOnly = async (vfsName, clearOnInit = false) => {
  try {
    const { driver, diagnostics } = await WorkerSqlDriver.open({
      path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit,
    });
    await driver.close();
    driver.terminate();
    return { ok: true, diagnostics };
  } catch (e) {
    const err = e as SqlOpenError;
    return { ok: false, reason: err.reason, name: err.detail?.name, message: err.message };
  }
};

window.releaseHeld = async (usePause) => {
  const d = window.__held;
  if (!d) return { ok: false, message: 'nothing held' };
  // The cooperative handoff: close handles, pause the VFS (which THROWS if any
  // handle is still open, so the close has to be real), then the next context
  // can install. SQLite 3.50's pauseVfs/unpauseVfs. docs/15 §3c.
  if (usePause) await d.pause(); else await d.close();
  d.terminate();
  window.__held = undefined;
  return { ok: true };
};

window.reopenAndCount = async (vfsName, table) => {
  try {
    const { driver, diagnostics } = await WorkerSqlDriver.open({
      path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit: false,
    });
    const { rows } = await driver.query(`SELECT COUNT(*) FROM ${table}`, [], 'get');
    const integrity = await driver.query('PRAGMA integrity_check', [], 'get');
    await driver.close();
    driver.terminate();
    return {
      ok: true,
      count: Number((rows as unknown[])[0]),
      integrity: String((integrity.rows as unknown[])[0]),
      journalMode: diagnostics.journalMode,
    };
  } catch (e) {
    const err = e as SqlOpenError;
    return { ok: false, reason: err.reason, message: err.message };
  }
};

window.holdOpen = async (vfsName) => {
  const { driver, diagnostics } = await WorkerSqlDriver.open({
    path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  await migrate(driver);
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    ['pr_hold', 'Held Project', Date.now(), Date.now()], 'run');
  window.__held = driver;
  return { ok: true, diagnostics };
};


window.runConformance = async (vfsName) => {
  const { driver } = await WorkerSqlDriver.open({
    path: '/lorescribe-conformance.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  await driver.setJournalMode('wal', 'NORMAL');
  try { return await runConformance(driver); }
  finally { await driver.close(); driver.terminate(); }
};

window.schemaDump = async (vfsName) => {
  const { driver } = await WorkerSqlDriver.open({
    path: '/lorescribe-schemadump.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  try {
    await migrate(driver);
    const { rows } = await driver.query(
      `SELECT type || ' ' || name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'
       ORDER BY type, name`, [], 'all');
    return (rows as unknown[][]).map((r) => String(r[0]));
  } finally { await driver.close(); driver.terminate(); }
};

window.reopenUnderJournalMode = async (vfsName, mode) => {
  const steps: string[] = [];
  try {
    const a = await WorkerSqlDriver.open({
      path: '/lorescribe-reopen.db', vfsName, minimumCapacity: 8, clearOnInit: true,
    });
    const eff = await a.driver.setJournalMode(mode, mode === 'wal' ? 'NORMAL' : 'FULL');
    steps.push(`opened, journal=${eff.journalMode}`);
    await a.driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.driver.query('INSERT INTO t (id,v) VALUES (?,?)', [1, 'survived'], 'run');
    const d1 = await a.driver.diagnostics();
    steps.push(`wrote; pool files ${d1.fileCount}/${d1.capacity}`);
    await a.driver.close();
    a.driver.terminate();
    steps.push('closed cleanly');

    const b = await WorkerSqlDriver.open({
      path: '/lorescribe-reopen.db', vfsName, minimumCapacity: 8, clearOnInit: false,
    });
    const d2 = await b.driver.diagnostics();
    const { rows } = await b.driver.query('SELECT v FROM t WHERE id = 1', [], 'get');
    await b.driver.close();
    b.driver.terminate();
    return { ok: true, steps, reopened: String((rows as unknown[])[0]),
             journalOnReopen: d2.journalMode, poolFiles: `${d2.fileCount}/${d2.capacity}` };
  } catch (e) {
    const err = e as SqlOpenError;
    return { ok: false, steps, reason: err.reason, message: err.message };
  }
};
