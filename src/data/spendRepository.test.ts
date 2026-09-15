import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { RunsRepository } from './runsRepository';
import { SpendRepository } from './spendRepository';
import { DEFAULT_CAPS, localDayStart } from '../domain/spend';

/** Fixtures invented — D14. */

let driver: NodeSqlDriver;
let runs: RunsRepository;
let spend: SpendRepository;
const NOW = new Date(2026, 8, 15, 14, 0, 0).getTime();

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  runs = new RunsRepository(driver);
  spend = new SpendRepository(driver, runs);
  for (const id of ['p1', 'p2']) {
    await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [id, id], 'run');
  }
});

/** A finished run at a moment, priced or not. */
async function run(projectId: string, createdAt: number, costUsd: number | null, tokens = true) {
  const id = await runs.start(projectId, {
    sceneId: null, purpose: 'draft_beat', provider: 'openrouter', model: 'm', params: {}, briefJson: '{}',
    promptRendered: '',
  });
  await driver.query('UPDATE ai_run SET created_at = ? WHERE id = ?', [createdAt, id], 'run');
  await runs.finish(id, {
    outputText: 'x', tokensIn: tokens ? 10 : null, tokensOut: tokens ? 5 : null, tokensReasoning: 0, costUsd,
    latencyMs: 1, status: 'ok', servedBy: null,
  });
  return id;
}

describe('caps', () => {
  it('default to D17 until set, then come back as set, with other settings untouched', async () => {
    await driver.query('UPDATE project SET settings_json = ? WHERE id = ?', ['{"ui":{"theme":"dark"}}', 'p1'], 'run');
    expect(await spend.caps('p1')).toEqual(DEFAULT_CAPS);
    expect(await spend.setCaps('p1', { warnUsd: 10, stopUsd: 40 })).toEqual({ warnUsd: 10, stopUsd: 40 });
    expect(await spend.caps('p1')).toEqual({ warnUsd: 10, stopUsd: 40 });
    const [row] = (await driver.query(
      'SELECT settings_json, rev FROM project WHERE id = ?', ['p1'], 'all')).rows as [string, number][];
    expect(JSON.parse(row![0])).toEqual({ ui: { theme: 'dark' }, spend: { warnUsd: 10, stopUsd: 40 } });
    expect(row![1]).toBe(2);
    // Per project: the other one still has the defaults.
    expect(await spend.caps('p2')).toEqual(DEFAULT_CAPS);
    const ops = (await driver.query(
      "SELECT payload FROM op_log WHERE table_name = 'project' AND row_id = 'p1'", [], 'all')).rows as [string][];
    expect(ops.map((o) => JSON.parse(o[0]))).toEqual([{ settings: { spend: { warnUsd: 10, stopUsd: 40 } } }]);
  });

  it('refuse a warning above the stop and leave the row alone', async () => {
    await expect(spend.setCaps('p1', { warnUsd: 50, stopUsd: 20 })).rejects.toThrow(/cannot be higher/);
    expect(await spend.caps('p1')).toEqual(DEFAULT_CAPS);
    expect(((await driver.query('SELECT rev FROM project WHERE id = ?', ['p1'], 'all')).rows as [number][])[0]![0]).toBe(1);
  });

  it('name a project that is not there', async () => {
    await expect(spend.caps('nope')).rejects.toThrow(/no longer exists/);
  });
});

describe('the meter', () => {
  it('sums only today, only this project, only priced runs — and counts the unpriced ones', async () => {
    const dayStart = localDayStart(NOW);
    await run('p1', NOW - 3600_000, 3);           // today
    await run('p1', dayStart, 2.5);               // the first instant of today counts
    await run('p1', dayStart - 1, 100);           // yesterday, one millisecond before
    await run('p2', NOW, 100);                    // another project
    await run('p1', NOW, null);                   // used tokens, no price
    await run('p1', NOW, null, false);            // no tokens either: not a spend at all
    await runs.block('p1', { sceneId: null, purpose: 'draft_beat', provider: null, model: null, reason: 'over' });

    const meter = await spend.meter('p1', NOW);
    expect(meter.todayUsd).toBeCloseTo(5.5);
    expect(meter.unpricedRuns).toBe(1);
    expect(meter.dayStart).toBe(dayStart);
    expect(meter.caps).toEqual(DEFAULT_CAPS);
    expect(meter.level).toBe('warn');
  });

  it('reads the level from the project’s own caps', async () => {
    await run('p1', NOW, 5);
    expect((await spend.meter('p1', NOW)).level).toBe('warn');
    await spend.setCaps('p1', { warnUsd: 10, stopUsd: 20 });
    expect((await spend.meter('p1', NOW)).level).toBe('ok');
    await spend.setCaps('p1', { warnUsd: 1, stopUsd: 5 });
    expect((await spend.meter('p1', NOW)).level).toBe('stop');
  });
});

describe('a blocked run', () => {
  it('is recorded with its reason, and never counts as spend', async () => {
    const id = await runs.block('p1', {
      sceneId: null, purpose: 'draft_beat', provider: 'openrouter', model: 'm', reason: 'past the $20 stop',
    });
    expect(await runs.get(id)).toMatchObject({
      status: 'blocked', blockReason: 'past the $20 stop', costUsd: null, provider: 'openrouter', accepted: false,
    });
    expect(await runs.spentSince('p1', 0)).toBe(0);
    expect(await runs.unpricedSince('p1', 0)).toBe(0);
  });
});
