import { WorkerSqlDriver } from '../db/client';
import { migrate } from '../db/migrate';
import { buildCorpus, DEFAULT_SPEC, type CorpusSpec } from './corpus';
import type { Diagnostics } from '../db/protocol';

export interface Stat { p50: number; p95: number; max: number; n: number }
export interface Measurement {
  key: string;
  label: string;
  target: string;
  value: number | string | null;
  unit: string;
  pass: boolean | null;
  detail?: string;
}
export interface SpikeResult {
  startedAt: string;
  userAgent: string;
  origin: string;
  spec: CorpusSpec;
  totalWords: number;
  diagnostics: Diagnostics | null;
  measurements: Measurement[];
  failure?: { reason: string; name: string; message: string };
}

function stat(xs: number[]): Stat {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0, n: s.length };
}
const ms = (n: number) => Math.round(n * 100) / 100;

/**
 * Samples the longest gap between animation frames while work happens. This is
 * the number a writer actually feels: a dropped frame mid-sentence.
 */
function frameWatch() {
  let last = performance.now();
  let worst = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop: () => { running = false; return worst; } };
}

export async function runSpike(
  spec: CorpusSpec = DEFAULT_SPEC,
  opts: { clearOnInit?: boolean; log?: (s: string) => void } = {},
): Promise<SpikeResult> {
  const log = opts.log ?? (() => {});
  const out: Measurement[] = [];
  const result: SpikeResult = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    origin: location.origin,
    spec, totalWords: 0, diagnostics: null, measurements: out,
  };

  // --- persist(): heuristic, never prompted, and documented only as of 2020.
  // So we measure it rather than assume it. Main thread only: the method does
  // not exist on WorkerNavigator. docs/15 §7.
  let persisted: boolean | null = null;
  try {
    persisted = await navigator.storage.persist();
  } catch { persisted = null; }
  const est = await navigator.storage.estimate().catch(() => null);

  // --- Cold open: worker boot -> VFS install -> first query.
  const t0 = performance.now();
  let driver: WorkerSqlDriver;
  let diagnostics: Diagnostics;
  try {
    const opened = await WorkerSqlDriver.open({
      path: '/lorescribe-spike.db',      // absolute: sahpool mishandles relative
      vfsName: 'lorescribe-spike',
      minimumCapacity: 8,                // >= 2x expected files; docs/15 §7
      clearOnInit: opts.clearOnInit ?? true,
    });
    driver = opened.driver;
    diagnostics = opened.diagnostics;
  } catch (e) {
    const err = e as { reason?: string; name: string; message: string };
    result.failure = { reason: err.reason ?? 'unknown', name: err.name, message: err.message };
    return result;
  }
  const coldOpen = performance.now() - t0;
  result.diagnostics = diagnostics;
  log(`opened: vfs=${diagnostics.vfsName} journal=${diagnostics.journalMode} capacity=${diagnostics.capacity}`);

  out.push({
    key: 'cold_open', label: 'Cold open (worker boot → VFS install → first query)',
    target: '< 1500', value: ms(coldOpen), unit: 'ms', pass: coldOpen < 1500,
  });

  // --- Migration: db/schema.sql as 001, user_version as source of truth.
  const tMig = performance.now();
  const mig = await migrate(driver);
  const migMs = performance.now() - tMig;
  out.push({
    key: 'migrate', label: 'Apply migration 001 (52 tables, 5 views, 2 FTS)',
    target: 'informational', value: ms(migMs), unit: 'ms', pass: null,
    detail: `user_version ${mig.from} → ${mig.to}`,
  });

  // --- Why is bulk insert slow? Measure, don't theorise.
  //
  // The first run came in at 539 rows/s against a 5,000 target. Prepared-
  // statement caching moved it to 565, so statement compilation was not the
  // cost. The remaining suspect is the journal: in `delete` mode every commit
  // creates, fsyncs and deletes a rollback journal file, and the corpus loader
  // was committing ~304 times. This isolates journal mode from transaction
  // count on a scratch table before the real load runs.
  await driver.exec('CREATE TABLE IF NOT EXISTS _bench (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)');
  const benchRows = 4000;
  const benchItems = Array.from({ length: benchRows }, (_, i) => ({
    sql: 'INSERT INTO _bench (a,b) VALUES (?,?)', params: [`row ${i} ${'x'.repeat(40)}`, i],
  }));
  const profile: { mode: string; txns: number; rowsPerSec: number; effective: string }[] = [];

  for (const [mode, sync] of [['delete', 'FULL'], ['memory', 'OFF'], ['wal', 'NORMAL']] as const) {
    const eff = await driver.setJournalMode(mode, sync);
    for (const txns of [1, 100]) {
      await driver.query('DELETE FROM _bench', [], 'run');
      const per = Math.ceil(benchRows / txns);
      const t = performance.now();
      if (txns === 1) {
        await driver.exec('BEGIN');
        for (let i = 0; i < benchRows; i += per) await driver.batch(benchItems.slice(i, i + per), false);
        await driver.exec('COMMIT');
      } else {
        for (let i = 0; i < benchRows; i += per) await driver.batch(benchItems.slice(i, i + per), true);
      }
      const dt = performance.now() - t;
      profile.push({ mode, txns, rowsPerSec: Math.round(benchRows / (dt / 1000)), effective: eff.journalMode });
    }
  }
  out.push({
    key: 'journal_profile', label: 'Bulk insert by journal mode × transaction count',
    target: 'informational',
    value: profile.map((p) => `${p.effective}/${p.txns}txn ${p.rowsPerSec.toLocaleString()}`).join('  ·  '),
    unit: 'rows/s', pass: null,
    detail: 'within one transaction the modes are indistinguishable; the spread is entirely per-commit cost',
  });
  await driver.exec('DROP TABLE _bench');

  // `memory` is fastest and is NOT a candidate: its rollback journal lives in
  // RAM, so a crash mid-transaction can corrupt the file. Fast and unsafe is
  // not a trade this project gets to make. Imports therefore run in `delete`
  // with one transaction, which the profile shows costs nothing.
  const chosen = await driver.setJournalMode('delete', 'FULL');

  // --- Bulk insert throughput.
  log('generating corpus…');
  const corpus = buildCorpus(spec);
  result.totalWords = corpus.totalWords;
  let rowCount = 0;
  const tBulk = performance.now();
  await driver.exec('BEGIN');
  for (const batch of corpus.statements) {
    await driver.batch(batch, false); // one transaction spans the whole load
    rowCount += batch.length;
  }
  await driver.exec('COMMIT');
  const bulkMs = performance.now() - tBulk;
  const rowsPerSec = Math.round(rowCount / (bulkMs / 1000));
  out.push({
    key: 'bulk_insert', label: 'Bulk insert throughput',
    target: '> 5000', value: rowsPerSec, unit: 'rows/s', pass: rowsPerSec > 5000,
    detail: `${rowCount.toLocaleString()} rows in ${Math.round(bulkMs)} ms, journal=${chosen.journalMode}, single transaction`,
  });

  // --- Load one scene + its version list.
  const sceneTimes: number[] = [];
  for (let i = 0; i < 40; i++) {
    const id = corpus.sceneIds[(i * 7) % corpus.sceneIds.length]!;
    const t = performance.now();
    await driver.query('SELECT * FROM scene WHERE id = ?', [id], 'get');
    await driver.query(
      'SELECT id,label,origin,word_count,is_active,created_at FROM scene_version WHERE scene_id = ? ORDER BY created_at',
      [id], 'all');
    sceneTimes.push(performance.now() - t);
  }
  const sceneStat = stat(sceneTimes);
  out.push({
    key: 'scene_load', label: 'Load one scene + its version list',
    target: '< 50 (p95)', value: ms(sceneStat.p95), unit: 'ms', pass: sceneStat.p95 < 50,
    detail: `p50 ${ms(sceneStat.p50)} / max ${ms(sceneStat.max)} over ${sceneStat.n}`,
  });

  // --- Autosave: the workload that decides how the app FEELS, and the one the
  // journal profile above says is sensitive. One row, one commit, repeatedly —
  // the exact shape `delete` mode is worst at. Measured under both durable
  // modes rather than assumed.
  const autosave: Record<string, Stat> = {};
  let worstFrame = 0;
  for (const mode of ['delete', 'wal'] as const) {
    const eff = await driver.setJournalMode(mode, mode === 'wal' ? 'NORMAL' : 'FULL');
    const fw = frameWatch();
    const saveTimes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const id = corpus.sceneIds[(i * 11) % corpus.sceneIds.length]!;
      const body = `revised ${i} ` + 'lorem '.repeat(400);
      const t = performance.now();
      await driver.query(
        'UPDATE scene SET content_text = ?, word_count = ?, updated_at = ?, rev = rev + 1 WHERE id = ?',
        [body, 401, Date.now(), id], 'run');
      saveTimes.push(performance.now() - t);
    }
    worstFrame = Math.max(worstFrame, fw.stop());
    autosave[eff.journalMode] = stat(saveTimes);
    log(`autosave under ${eff.journalMode}: p95 ${ms(stat(saveTimes).p95)} ms`);
  }
  const modes = Object.keys(autosave);
  const bestAutosave = modes.reduce((a, b) => (autosave[a]!.p95 <= autosave[b]!.p95 ? a : b));
  const bestStat = autosave[bestAutosave]!;
  out.push({
    key: 'autosave', label: 'Autosave write of a scene body (best durable journal mode)',
    target: '< 30 (p95)', value: ms(bestStat.p95), unit: 'ms', pass: bestStat.p95 < 30,
    detail: modes.map((m) => `${m}: p95 ${ms(autosave[m]!.p95)} / p50 ${ms(autosave[m]!.p50)}`).join('  ·  ')
      + `  →  use ${bestAutosave}`,
  });
  out.push({
    key: 'frame_block', label: 'Longest main-thread frame gap during sustained writes',
    target: '< 50', value: ms(worstFrame), unit: 'ms', pass: worstFrame < 50,
  });
  await driver.setJournalMode(bestAutosave, bestAutosave === 'wal' ? 'NORMAL' : 'FULL');

  // --- FTS across the whole corpus.
  const ftsTimes: number[] = [];
  for (const term of corpus.probeTerms.slice(0, 12)) {
    const t = performance.now();
    await driver.query(
      `SELECT scene_id, snippet(scene_fts, 2, '[', ']', '…', 12) FROM scene_fts WHERE scene_fts MATCH ? LIMIT 50`,
      [term], 'all');
    ftsTimes.push(performance.now() - t);
  }
  const tRare = performance.now();
  const rare = await driver.query(
    `SELECT scene_id FROM scene_fts WHERE scene_fts MATCH ?`, [corpus.rareTerm], 'all');
  ftsTimes.push(performance.now() - tRare);
  const ftsStat = stat(ftsTimes);
  out.push({
    key: 'fts', label: `FTS query across ${corpus.totalWords.toLocaleString()} words`,
    target: '< 200 (p95)', value: ms(ftsStat.p95), unit: 'ms', pass: ftsStat.p95 < 200,
    detail: `p50 ${ms(ftsStat.p50)}; rare-term hit rows: ${(rare.rows as unknown[]).length}`,
  });

  // --- A scene-brief-shaped query set: the Phase 2 workload, approximated.
  const briefTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = corpus.sceneIds[(i * 29) % corpus.sceneIds.length]!;
    const t = performance.now();
    const seeds = await driver.query(
      `SELECT entity_id, role FROM mention WHERE scene_id = ?
       ORDER BY CASE role WHEN 'pov' THEN 0 WHEN 'focus' THEN 1 WHEN 'present' THEN 2 ELSE 3 END`,
      [id], 'all');
    const ids = (seeds.rows as unknown[][]).slice(0, 12).map((r) => r[0]);
    const ph = ids.map(() => '?').join(',');
    await driver.query(`SELECT id,name,summary,importance FROM entity WHERE id IN (${ph})`, ids, 'all');
    await driver.query(`SELECT alias, entity_id FROM entity_alias WHERE entity_id IN (${ph})`, ids, 'all');
    // The temporal filter: established by now, revealed by now. The product thesis.
    await driver.query(
      `SELECT f.id, f.statement, f.spoiler_weight FROM fact f
       JOIN scene est ON est.id = f.established_at_scene_id
       JOIN scene cur ON cur.id = ?
       WHERE f.subject_entity_id IN (${ph})
         AND est.global_rank <= cur.global_rank
         AND f.deleted_at IS NULL
       ORDER BY f.spoiler_weight DESC LIMIT 80`, [id, ...ids], 'all');
    await driver.query(
      `SELECT s.id, s.summary FROM scene s JOIN scene cur ON cur.id = ?
       WHERE s.global_rank < cur.global_rank ORDER BY s.global_rank DESC LIMIT 12`, [id], 'all');
    await driver.query(`SELECT id,title,summary FROM chapter WHERE book_id = ? ORDER BY sort_key`, ['bk_0001'], 'all');
    briefTimes.push(performance.now() - t);
  }
  const briefStat = stat(briefTimes);
  out.push({
    key: 'brief_queries', label: 'Scene-brief-shaped query set (6 queries × 10 scenes)',
    target: '< 500 (p95)', value: ms(briefStat.p95), unit: 'ms', pass: briefStat.p95 < 500,
    detail: `p50 ${ms(briefStat.p50)} / max ${ms(briefStat.max)}`,
  });

  // --- Size and capacity: the R2 answer.
  const post = await driver.diagnostics();
  const mb = post.dbBytes ? Math.round((post.dbBytes / 1048576) * 10) / 10 : null;
  out.push({
    key: 'db_size', label: `Database size at ${corpus.totalWords.toLocaleString()} words, ${spec.versionsPerScene} versions/scene`,
    target: 'measured', value: mb, unit: 'MB', pass: null,
    detail: `${post.pageSize} B pages`,
  });
  out.push({
    key: 'pool_capacity', label: 'Pool files consumed / capacity',
    target: 'measured', value: `${post.fileCount} / ${post.capacity}`, unit: 'files', pass: null,
    detail: 'capacity is a FILE COUNT, not bytes; default 6',
  });
  const estAfter = await navigator.storage.estimate().catch(() => null);
  out.push({
    key: 'quota', label: 'Origin quota / usage',
    target: 'measured',
    value: estAfter ? `${Math.round((estAfter.usage ?? 0) / 1048576)} / ${Math.round((estAfter.quota ?? 0) / 1048576)}` : null,
    unit: 'MB', pass: null,
    detail: est ? `usage before corpus: ${Math.round((est.usage ?? 0) / 1048576)} MB` : undefined,
  });
  out.push({
    key: 'persist', label: 'navigator.storage.persist() granted',
    target: 'measured', value: String(persisted), unit: '', pass: null,
    detail: 'heuristic, never prompted; Chrome guidance last documented 2020',
  });

  // --- Pragmas: read back, never assumed.
  out.push({
    key: 'pragmas', label: 'Effective pragmas (read back, not assumed)',
    target: 'informational',
    value: `journal=${post.journalMode} locking=${post.lockingMode} temp_store=${post.tempStore} fk=${post.foreignKeys}`,
    unit: '', pass: null,
    detail: `SQLite ${post.sqliteVersion}`,
  });

  await driver.close();
  driver.terminate();
  return result;
}
