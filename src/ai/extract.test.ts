import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { RunsRepository } from '../data/runsRepository';
import { ProviderRepository } from '../data/providerRepository';
import { SpendRepository } from '../data/spendRepository';
import { CodexRepository } from '../data/codexRepository';
import { FactsRepository } from '../data/factsRepository';
import { ManuscriptRepository } from '../data/manuscriptRepository';
import { PlanRepository } from '../data/planRepository';
import { ImportRepository } from '../data/importRepository';
import { EncryptedCredentialStore, MemoryVault } from './credentials';
import { Extractor, groupOutcomes, type ChunkOutcome, type ExtractEvent } from './extract';
import { NoModelError } from './roles';
import { ProviderError, type ChatDelta, type ChatRequest, type ProviderAdapter } from './provider';
import { parseMarkdown } from '../import/markdown';
import type { ExtractTypes } from '../domain/extract';

/**
 * The extraction lane against the real database with a fake extract model.
 * What is proved is the shape around the call: one run per chunk under the
 * cap, proposals staged with their evidence, accept-all sparing the
 * unverified, and every failure named rather than skipped. Fixtures invented — D14.
 */

const P = 'p1';
let driver: NodeSqlDriver;
let runs: RunsRepository;
let providers: ProviderRepository;
let spend: SpendRepository;
let imports: ImportRepository;
let credentials: EncryptedCredentialStore;
let accountId: string;

const types: ExtractTypes = {
  types: [{ key: 'character', label: 'Character' }],
  existing: new Map(),
};
const docs = [
  parseMarkdown('cast/ilva.md', '# Ilva\nShe keeps the seal, and the gate behind it.\n'),
  parseMarkdown('cast/renn.md', '# Renn\nHe counts the crates and says nothing.\n'),
];

function fake(script: (req: ChatRequest, n: number) => ChatDelta[] | Error) {
  const asked: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    id: 'fake', listModels: async () => [], countTokens: (t) => t.length,
    capabilities: () => ({
      contextWindow: 8000, supportsTools: false, supportsJsonSchema: false, supportsStrictSchema: false,
      costIn: null, costOut: null, reasoningAllowance: 0,
    }),
    async *chat(req) {
      asked.push(req);
      const out = script(req, asked.length);
      if (out instanceof Error) throw out;
      for (const d of out) yield d;
    },
  };
  return { adapter, asked };
}

const answer = (json: unknown, tokensOut = 80): ChatDelta[] => [
  { kind: 'text', text: JSON.stringify(json) },
  { kind: 'usage', promptTokens: 400, completionTokens: tokensOut, reasoningTokens: 0 },
  { kind: 'done', finishReason: 'stop', servedBy: 'Cheap' },
];

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  runs = new RunsRepository(driver);
  providers = new ProviderRepository(driver);
  spend = new SpendRepository(driver, runs);
  credentials = new EncryptedCredentialStore(new MemoryVault());
  const codex = new CodexRepository(driver);
  const manuscript = new ManuscriptRepository(driver);
  imports = new ImportRepository(
    driver, codex, new FactsRepository(driver), manuscript, new PlanRepository(driver));
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [P, 'P'], 'run');
  const account = await providers.addAccount({ kind: 'openrouter', label: 'Mine' });
  accountId = account.id;
  await credentials.save(accountId, 'sk-or-v1-fake');
  await providers.setCredentialRef(accountId, accountId);
  await providers.setProfile(P, 'extract', {
    providerAccountId: accountId, modelId: 'fake/cheap', costInPerMtok: 0.1, costOutPerMtok: 0.4,
  });
});

async function run(adapter: ProviderAdapter, signal = new AbortController().signal) {
  const x = new Extractor({ runs, providers, credentials, spend, imports, adapterFor: () => adapter });
  const events: ExtractEvent[] = [];
  for await (const ev of x.extract(P, docs, types, signal)) events.push(ev);
  return events;
}
const done = (events: ExtractEvent[]) => events.at(-1) as Extract<ExtractEvent, { kind: 'done' }>;

describe('the extraction lane', () => {
  it('reads each chunk in its own run, stages what it found with evidence, and accepts only the verified', async () => {
    const { adapter, asked } = fake((req, n) => {
      expect(req.model).toBe('fake/cheap');
      expect(req.temperature).toBe(0);
      return n === 1
        ? answer({ entities: [
          { name: 'Ilva', type: 'character', summary: 'Keeper.', quote: 'keeps the seal, and the gate', confidence: 0.9 },
          { name: 'Maren', type: 'character', summary: 'Invented.', quote: 'Maren came in from the rain', confidence: 0.8 },
        ] })
        : answer({ entities: [
          { name: 'Renn', type: 'character', summary: 'Counts crates.', quote: 'counts the crates', confidence: 0.7 },
          { name: 'The Counting House', type: 'Institution', summary: 'Where Renn counts.', quote: 'counts the crates' },
        ],
        facts: [{ subject: 'Renn', statement: 'Renn says nothing.', quote: 'says nothing', confidence: 0.6 }],
        unplaced: [{ what: 'The crate tally', why: 'A ledger; a timeline of shipments.', quote: 'counts the crates' }] });
    });
    const events = await run(adapter);
    expect(events[0]).toMatchObject({ kind: 'plan', chunks: 2, files: 2 });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.messages[0]!.content).toContain('SOURCE (cast/ilva.md)');
    const outcomes = events.filter((e) => e.kind === 'chunk') as (ExtractEvent & ChunkOutcome)[];
    expect(outcomes.map((o) => [o.state, o.proposals, o.attempts])).toEqual([['ok', 2, 1], ['ok', 2, 1]]);
    expect(outcomes.every((o) => o.runId !== null && o.costUsd !== null)).toBe(true);

    const d = done(events);
    expect(d).toMatchObject({ proposals: 4, unverified: 1, dropped: [], problems: [] });
    // What had no home is recommended, with the entries held for the writer's decision.
    expect(d.recommendations.map((r) => r.kind)).toEqual(['new_type', 'unplaced']);
    expect(d.recommendations[0]).toMatchObject({ kind: 'new_type', typeKey: 'institution', names: ['The Counting House'] });
    expect(d.costUsd).toBeCloseTo(2 * (400 * 0.1 + 80 * 0.4) / 1_000_000);
    expect(d.runId).not.toBeNull();

    const staged = await imports.listProposals(d.runId!);
    expect(staged.map((p) => [p.targetTable, p.status, p.evidenceVerified])).toEqual([
      ['entity', 'accepted', true], ['entity', 'pending', false], ['entity', 'accepted', true], ['fact', 'accepted', true],
    ]);
    expect(staged[0]!.payload).toMatchObject({ name: 'Ilva', typeKey: 'character', summary: 'Keeper.' });
    expect(staged[0]!.evidenceQuote).toBe('keeps the seal, and the gate');

    const aiRuns = (await runs.list(P)).filter((r) => r.purpose === 'extract');
    expect(aiRuns).toHaveLength(2);
    expect(aiRuns.every((r) => r.status === 'ok' && r.servedBy === 'Cheap')).toBe(true);
    const [[aiRunId]] = (await driver.query('SELECT ai_run_id FROM proposal_run WHERE id = ?', [d.runId], 'all')).rows as [[string]];
    expect(aiRuns.map((r) => r.id)).toContain(aiRunId);

    // Applying the run lands only the two accepted entities and the fact.
    await imports.apply(P, d.runId!);
    const names = (await driver.query('SELECT name FROM entity WHERE deleted_at IS NULL ORDER BY name', [], 'all')).rows;
    expect(names).toEqual([['Ilva'], ['Renn']]);
  });

  it('asks once more, firmly, when the answer is not JSON; names it malformed only when that fails too', async () => {
    const { adapter, asked } = fake((_req, n) => (n <= 2
      ? [{ kind: 'text', text: 'I would rather not list these.' },
        { kind: 'done', finishReason: 'stop', servedBy: null }]
      : new ProviderError('refused', 'Nope', 403)));
    const d = done(await run(adapter));
    expect(d.proposals).toBe(0);
    expect(d.runId).toBeNull();
    expect(asked).toHaveLength(3);
    expect(asked[1]!.messages[0]!.content).toContain('Your previous answer was not one JSON object.');
    expect(asked[0]!.messages[0]!.content).not.toContain('Your previous answer');
    expect(d.problems.map((p) => [p.state, p.attempts])).toEqual([['malformed', 2], ['refused', 1]]);
    expect(d.problems[0]!.detail).toContain('even when asked again');
    expect(d.problems[1]!.detail).toBe('The provider declined: Nope');
    // Every attempt is its own run, and the model's words are kept on it.
    const list = await runs.list(P);
    expect(list.map((r) => r.status).sort()).toEqual(['ok', 'ok', 'refused']);
    expect((await runs.get(d.problems[0]!.runId!))?.outputText).toBe('I would rather not list these.');
  });

  it('recovers when the second attempt answers properly', async () => {
    const { adapter, asked } = fake((_req, n) => (n === 1
      ? [{ kind: 'text', text: 'Sure! Here is a summary of the file instead.' },
        { kind: 'done', finishReason: 'stop', servedBy: null }]
      : answer({ entities: [{ name: 'Ilva', type: 'character', summary: 'x', quote: 'keeps the seal, and the gate' }] })));
    const events = await run(adapter);
    const first = events.find((e) => e.kind === 'chunk') as ExtractEvent & ChunkOutcome;
    expect(first).toMatchObject({ state: 'ok', proposals: 1, attempts: 2 });
    expect(asked).toHaveLength(3); // two for the first chunk, one for the second
    expect(done(events).problems).toEqual([]);
  });

  it('gives a cut-off answer twice the room the second time, then names it truncated', async () => {
    const { adapter, asked } = fake(() => [
      { kind: 'text', text: '{"entities": [{"name": "Ilva", "type": "cha' },
      { kind: 'usage', promptTokens: 400, completionTokens: 800, reasoningTokens: 3000 },
      { kind: 'done', finishReason: 'length', servedBy: 'Cheap' },
    ]);
    const d = done(await run(adapter));
    expect(d.problems.map((p) => [p.state, p.attempts])).toEqual([['truncated', 2], ['truncated', 2]]);
    expect(d.problems[0]!.detail).toContain('cut off');
    // The retry has at least twice the first budget plus the reasoning the first answer taught the profile.
    expect(asked[1]!.maxTokens).toBeGreaterThanOrEqual(asked[0]!.maxTokens * 2 + 3000);
    expect((await runs.list(P)).filter((r) => r.status === 'truncated')).toHaveLength(4);
  });

  it('explains a provider failure in the writer\'s terms', async () => {
    const { adapter } = fake(() => new ProviderError('bad-request', 'No endpoints found matching your data policy', 404));
    const d = done(await run(adapter));
    expect(d.problems[0]).toMatchObject({
      state: 'failed', attempts: 1,
      detail: 'OpenRouter rejected the request: No endpoints found matching your data policy',
    });
  });

  it('stops at the spend cap, names the chunks it never sent, and stages what came before', async () => {
    // The first call is allowed and costs over a cent; that trips the two-cent stop for the second.
    const { adapter, asked } = fake(() => answer({ entities: [
      { name: 'Ilva', type: 'character', summary: 'x', quote: 'keeps the seal, and the gate', confidence: 1 },
    ] }, 30_000));
    const earlier = await runs.start(P, {
      sceneId: null, purpose: 'draft_beat', provider: 'x', model: 'y', params: {}, briefJson: '{}', promptRendered: '',
    });
    await runs.finish(earlier, {
      outputText: 'x', tokensIn: 1, tokensOut: 1, tokensReasoning: 0, costUsd: 0.01, latencyMs: 1, status: 'ok', servedBy: null,
    });
    await spend.setCaps(P, { warnUsd: 0, stopUsd: 0.02 });
    const d = done(await run(adapter));
    expect(asked).toHaveLength(1);
    expect(d.problems.map((p) => [p.label, p.state])).toEqual([['cast/renn.md', 'blocked']]);
    expect(d.problems[0]!.detail).toContain('spend');
    expect(d.proposals).toBe(1);
    expect((await runs.list(P)).map((r) => [r.purpose, r.status])).toContainEqual(['extract', 'blocked']);
  });

  it('refuses without an extract model, before anything is sent', async () => {
    await driver.query('DELETE FROM model_profile', [], 'run');
    const { adapter, asked } = fake(() => answer({}));
    await expect(run(adapter)).rejects.toBeInstanceOf(NoModelError);
    expect(asked).toHaveLength(0);
  });

  it('marks the chunks after a cancellation as cancelled and keeps what arrived', async () => {
    const ctl = new AbortController();
    const { adapter } = fake(() => {
      ctl.abort();
      return answer({ entities: [{ name: 'Ilva', type: 'character', summary: 'x', quote: 'keeps the seal, and the gate' }] });
    });
    const d = done(await run(adapter, ctl.signal));
    expect(d.proposals).toBe(1);
    expect(d.problems.map((p) => [p.label, p.state, p.detail])).toEqual([['cast/renn.md', 'cancelled', null]]);
  });
});

describe('groupOutcomes', () => {
  const o = (index: number, state: ChunkOutcome['state'], detail: string | null, proposals = 0): ChunkOutcome => ({
    index, label: `f${index}.md`, state, proposals, costUsd: null, runId: `r${index}`, detail, attempts: 1,
  });
  it('folds failures with one reason into one group, keeps each read file, and holds first-seen order', () => {
    const groups = groupOutcomes([
      o(0, 'failed', 'no endpoints'), o(1, 'ok', null, 3), o(2, 'failed', 'no endpoints'),
      o(3, 'ok', null, 1), o(4, 'malformed', 'wrong shape'), o(5, 'failed', 'declined by policy'),
      o(6, 'failed', 'no endpoints'),
    ]);
    expect(groups.map((g) => [g.state, g.detail, g.outcomes.map((x) => x.index)])).toEqual([
      ['failed', 'no endpoints', [0, 2, 6]],
      ['ok', null, [1]],
      ['ok', null, [3]],
      ['malformed', 'wrong shape', [4]],
      ['failed', 'declined by policy', [5]],
    ]);
    expect(groupOutcomes([])).toEqual([]);
  });
});

describe('what is on the wire', () => {
  it('says when each call goes out and what has come back, thinking included', async () => {
    const { adapter } = fake(() => [
      { kind: 'reasoning', text: 'Let me read this.' },
      { kind: 'text', text: '{"entities": [{"name": "Ilva", "type": "character", ' },
      { kind: 'text', text: '"summary": "x", "quote": "keeps the seal, and the gate"}]}' },
      { kind: 'usage', promptTokens: 400, completionTokens: 80, reasoningTokens: 20 },
      { kind: 'done', finishReason: 'stop', servedBy: 'Cheap' },
    ]);
    const events = await run(adapter);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('plan');
    expect(kinds.filter((k) => k === 'sending')).toHaveLength(2);
    // Each chunk: sending, at least one receiving, then its outcome — in that order.
    const first = events.findIndex((e) => e.kind === 'sending');
    const firstChunk = events.findIndex((e) => e.kind === 'chunk');
    const receiving = events.slice(first, firstChunk).filter((e) => e.kind === 'receiving');
    expect(receiving.length).toBeGreaterThanOrEqual(1);
    expect(events[first]).toMatchObject({
      kind: 'sending', index: 0, label: 'cast/ilva.md', attempt: 1, chars: 0, reasoning: false,
    });
    expect((events[first] as { words: number; maxTokens: number }).words).toBeGreaterThan(0);
    expect((events[first] as { maxTokens: number }).maxTokens).toBeGreaterThanOrEqual(800);
    // The first thing back was reasoning: the screen can say the model is thinking before any text.
    expect(receiving[0]).toMatchObject({ kind: 'receiving', reasoning: true, chars: 0 });
    expect(events[firstChunk]).toMatchObject({ kind: 'chunk', state: 'ok', proposals: 1 });
  });
});
