import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ViolationsRepository } from './violationsRepository';
import { LawsRepository } from './lawsRepository';
import { RunsRepository } from './runsRepository';
import type { Finding } from '../domain/verify';

/** Fixtures invented — D14. */

let driver: NodeSqlDriver;
let repo: ViolationsRepository;
let lawId: string;
let runId: string;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  repo = new ViolationsRepository(driver);
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', ['p1', 'P'], 'run');
  lawId = (await new LawsRepository(driver).create('p1', { title: 'L', ruleText: 'r', category: 'style' })).id;
  runId = await new RunsRepository(driver).start('p1', {
    sceneId: null, purpose: 'draft_beat', provider: 'x', model: 'y', params: {}, briefJson: '{}', promptRendered: '',
  });
});

const finding = (over: Partial<Finding>): Finding => ({
  lawId, lawTitle: 'L', severity: 'must', source: 'rubric', quote: 'the offending words', start: 10, end: 29,
  explanation: 'why', suggestedFix: 'fix', evidenceVerified: true, ...over,
});

describe('ViolationsRepository', () => {
  it('records findings against the run, keeps the uncertain flag, and lists them in text order', async () => {
    const ids = await repo.record(runId, null, [
      finding({ start: 40, end: 52, quote: 'later words' }),
      finding({ source: 'heuristic', quote: null, start: null, end: null }),
      finding({ evidenceVerified: false, start: null, end: null, quote: 'invented' }),
      finding({}),
    ]);
    expect(ids).toHaveLength(4);
    const rows = await repo.listForRun(runId);
    expect(rows.map((r) => r.start)).toEqual([10, 40, null, null]);
    expect(rows[0]).toMatchObject({
      runId, lawId, severity: 'must', quote: 'the offending words', end: 29, evidenceVerified: true,
      explanation: 'why', suggestedFix: 'fix', resolution: 'pending',
    });
    expect(rows.filter((r) => !r.evidenceVerified).map((r) => r.quote)).toEqual(['invented']);
  });

  it('records nothing for nothing, and resolves one row', async () => {
    expect(await repo.record(runId, null, [])).toEqual([]);
    const [id] = await repo.record(runId, null, [finding({})]);
    await repo.resolve(id!, 'dismissed');
    expect((await repo.listForRun(runId))[0]?.resolution).toBe('dismissed');
  });

  it('refuses a finding about a law that does not exist', async () => {
    await expect(repo.record(runId, null, [finding({ lawId: 'ghost' })])).rejects.toThrow();
  });
});
