import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { RunsRepository } from './runsRepository';
import { ManuscriptRepository } from './manuscriptRepository';

let driver: NodeSqlDriver;
let runs: RunsRepository;
/** Two real scenes: `scene_id` is a foreign key, and a run about a scene that is not there is refused. */
let s1: string;
let s2: string;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  runs = new RunsRepository(driver);
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', ['p1', 'P'], 'run');
  const manuscript = new ManuscriptRepository(driver);
  const book = await manuscript.createBook('p1', 'B');
  const chapter = await manuscript.createChapter(book.id, 'C');
  s1 = (await manuscript.createScene(chapter.id, 'One')).id;
  s2 = (await manuscript.createScene(chapter.id, 'Two')).id;
});

describe('RunsRepository', () => {
  it('opens a run as running with the brief stored, then closes it', async () => {
    const id = await runs.start('p1', {
      sceneId: null, purpose: 'draft_beat', provider: 'openrouter', model: 'm',
      params: { maxTokens: 480 }, briefJson: '{"text":"brief"}', promptRendered: 'brief\n---\ngo',
    });
    expect(await runs.get(id)).toMatchObject({ status: 'running', outputText: null, accepted: false });
    const row = ((await driver.query(
      'SELECT brief_json, prompt_rendered, params_json FROM ai_run WHERE id = ?', [id], 'all')).rows as string[][])[0]!;
    expect(row[0]).toBe('{"text":"brief"}');
    expect(row[1]).toContain('go');
    expect(JSON.parse(row[2]!)).toEqual({ maxTokens: 480 });

    await runs.finish(id, {
      outputText: 'prose', tokensIn: 100, tokensOut: 50, tokensReasoning: 0, costUsd: 0.0012,
      latencyMs: 900, status: 'ok', servedBy: 'Anthropic', sanitizerActions: { changed: false },
    });
    expect(await runs.get(id)).toMatchObject({
      status: 'ok', outputText: 'prose', tokensIn: 100, tokensOut: 50, costUsd: 0.0012, servedBy: 'Anthropic',
    });
    await runs.accept(id);
    expect((await runs.get(id))?.accepted).toBe(true);
  });

  it('lists a scene’s runs newest first and sums what was spent', async () => {
    const start = (sceneId: string | null) => runs.start('p1', {
      sceneId, purpose: 'draft_beat', provider: 'openrouter', model: 'm', params: {}, briefJson: '{}', promptRendered: '',
    });
    const a = await start(s1);
    const b = await start(s1);
    const c = await start(s2);
    for (const [id, cost] of [[a, 0.5], [b, 0.25], [c, 1]] as const) {
      await runs.finish(id, {
        outputText: 'x', tokensIn: 1, tokensOut: 1, tokensReasoning: 0, costUsd: cost,
        latencyMs: 1, status: 'ok', servedBy: null,
      });
    }
    expect((await runs.list('p1', s1)).map((r) => r.id)).toEqual([b, a]);
    expect((await runs.list('p1')).length).toBe(3);
    expect(await runs.spentSince('p1', 0)).toBeCloseTo(1.75);
    expect(await runs.spentSince('p1', Date.now() + 1000)).toBe(0);
  });
});
