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
import { Extractor, type ExtractEvent } from './extract';
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
        : answer({ entities: [{ name: 'Renn', type: 'character', summary: 'Counts crates.', quote: 'counts the crates', confidence: 0.7 }],
          facts: [{ subject: 'Renn', statement: 'Renn says nothing.', quote: 'says nothing', confidence: 0.6 }] });
    });
    const events = await run(adapter);
    expect(events[0]).toMatchObject({ kind: 'plan', chunks: 2, files: 2 });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.messages[0]!.content).toContain('SOURCE (cast/ilva.md)');
    expect(events.filter((e) => e.kind === 'chunk').map((e) => (e as { state: string; proposals: number }).proposals))
      .toEqual([2, 2]);

    const d = done(events);
    expect(d).toMatchObject({ proposals: 4, unverified: 1, dropped: [], problems: [] });
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

  it('names a malformed answer and a refusal per chunk, and still stages the rest', async () => {
    const { adapter } = fake((_req, n) => (n === 1
      ? [{ kind: 'text', text: 'I would rather not list these.' },
        { kind: 'done', finishReason: 'stop', servedBy: null }]
      : new ProviderError('refused', 'Nope', 403)));
    const d = done(await run(adapter));
    expect(d.proposals).toBe(0);
    expect(d.runId).toBeNull();
    expect(d.problems.map((p) => [p.state, p.detail])).toEqual([
      ['malformed', 'the model did not answer in the shape asked for'], ['refused', 'Nope'],
    ]);
    expect((await runs.list(P)).map((r) => r.status).sort()).toEqual(['ok', 'refused']);
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
    expect(d.problems).toEqual([{ label: 'cast/renn.md', state: 'blocked', detail: expect.stringContaining('daily stop') }]);
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
    expect(d.problems).toEqual([{ label: 'cast/renn.md', state: 'cancelled', detail: null }]);
  });
});
