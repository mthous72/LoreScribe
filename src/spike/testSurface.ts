import { runSpike, type SpikeResult } from './measure';
import { runEditorSpike, type EditorSpikeResult } from './editorSpike';
import { WorkerSqlDriver } from '../db/client';
import { migrate } from '../db/migrate';
import { runConformance, type Case } from '../db/conformance';
import { exportProjectArchive, restoreArchive } from '../data/backup';
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
    /** Test surface: export a project, damage the archive, restore what survives. */
    backupRoundTrip: (vfsName: string, damage: 'none' | 'corrupt-line' | 'truncate') => Promise<unknown>;
    /** Test surface: pause the VFS, unpause it, and use the database again. */
    pauseAndResume: (vfsName: string) => Promise<unknown>;
    /** Test surface: the editor spike, doc 08's named Tiptap risk. */
    runEditorSpike: (words?: number, aliasCount?: number, keystrokes?: number) => Promise<EditorSpikeResult>;
    /** Test surface: what the migration runner produced. */
    migrationState: (vfsName: string) => Promise<unknown>;
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

window.migrationState = async (vfsName) => {
  const { driver } = await WorkerSqlDriver.open({
    path: '/lorescribe-migstate.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  try {
    const first = await migrate(driver);
    // Running it again must be a no-op: user_version already covers these.
    const second = await migrate(driver);
    const types = await driver.query(
      'SELECT key FROM entity_type WHERE project_id IS NULL ORDER BY key', [], 'all');
    const audit = await driver.query(
      'SELECT version, name FROM schema_migration ORDER BY version', [], 'all');
    const userVersion = await driver.query('PRAGMA user_version', [], 'get');
    return {
      firstApplied: first.applied.map((a) => a.version),
      secondApplied: second.applied.map((a) => a.version),
      userVersion: Number((userVersion.rows as unknown[])[0]),
      types: (types.rows as unknown[][]).map((r) => String(r[0])),
      audit: (audit.rows as unknown[][]).map((r) => `${r[0]}:${r[1]}`),
    };
  } finally { await driver.close(); driver.terminate(); }
};

window.runEditorSpike = async (words, aliasCount, keystrokes) => {
  const mount = document.createElement('div');
  mount.style.position = 'absolute';
  mount.style.left = '-10000px';
  document.body.appendChild(mount);
  try {
    return await runEditorSpike(mount, { words, aliasCount, keystrokes });
  } finally { mount.remove(); }
};

window.pauseAndResume = async (vfsName) => {
  const { driver } = await WorkerSqlDriver.open({
    path: '/lorescribe-resume.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  try {
    await migrate(driver);
    await driver.query('INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
      ['pr_resume', 'Resume', Date.now(), Date.now()], 'run');
    const before = await driver.query('SELECT COUNT(*) FROM project', [], 'get');
    await driver.pause();
    await driver.unpause();
    const after = await driver.query('SELECT COUNT(*) FROM project', [], 'get');
    const integrity = await driver.query('PRAGMA integrity_check', [], 'get');
    return {
      ok: true,
      beforePause: Number((before.rows as unknown[])[0]),
      afterUnpause: Number((after.rows as unknown[])[0]),
      integrity: String((integrity.rows as unknown[])[0]),
    };
  } catch (e) {
    return { ok: false, message: (e as { message?: string })?.message ?? String(e) };
  } finally { await driver.close().catch(() => {}); driver.terminate(); }
};

window.backupRoundTrip = async (vfsName, damage) => {
  const { driver } = await WorkerSqlDriver.open({
    path: '/lorescribe-backup.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  try {
    await migrate(driver);
    const now = Date.now();
    await driver.query('INSERT INTO project (id,title,premise,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['pr_b', 'The Grey Warden', 'A smith goes north.', now, now], 'run');
    await driver.query('INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['bk_b', 'pr_b', 'Book One', 'a0', now, now], 'run');
    await driver.query('INSERT INTO chapter (id,book_id,number,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ['ch_b', 'bk_b', 1, 'Chapter One', 'a0', now, now], 'run');
    for (let i = 0; i < 12; i++) {
      await driver.query(
        `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,content_text,word_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [`sc_${i}`, 'ch_b', `Scene ${i}`, `a${i}`, `02a${i}`, `Scene ${i} prose.`, 3, now, now], 'run');
    }
    await driver.query('INSERT INTO entity (id,project_id,type_key,name,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ['en_b', 'pr_b', 'character', 'Kaelen', 'A smith.', now, now], 'run');

    const exported = await exportProjectArchive(driver, 'pr_b', 2);

    let text = exported.text;
    if (damage === 'corrupt-line') {
      const lines = text.split('\n');
      lines[4] = '{"kind":"row","table":"scene",TRUNCATED';
      text = lines.join('\n');
    } else if (damage === 'truncate') {
      text = text.slice(0, Math.floor(text.length * 0.7));
    }

    // Wipe and restore into the same database.
    await driver.exec('DELETE FROM scene; DELETE FROM chapter; DELETE FROM book; DELETE FROM entity; DELETE FROM project;');
    const before = await driver.query('SELECT COUNT(*) FROM scene', [], 'get');
    const restored = await restoreArchive(driver, text);
    const scenes = await driver.query('SELECT COUNT(*) FROM scene', [], 'get');
    const title = await driver.query('SELECT title FROM project WHERE id = ?', ['pr_b'], 'get');
    const prose = await driver.query('SELECT content_text FROM scene WHERE id = ?', ['sc_0'], 'get');

    return {
      ok: true,
      exportedRows: exported.rows,
      emptyBefore: Number((before.rows as unknown[])[0]),
      applied: restored.applied,
      skipped: restored.skipped.length,
      problems: restored.problems.map((p) => p.reason),
      scenesAfter: Number((scenes.rows as unknown[])[0]),
      projectTitle: String((title.rows as unknown[])[0] ?? ''),
      firstScene: String((prose.rows as unknown[])[0] ?? ''),
    };
  } catch (e) {
    return { ok: false, message: (e as { message?: string })?.message ?? String(e) };
  } finally { await driver.close().catch(() => {}); driver.terminate(); }
};
