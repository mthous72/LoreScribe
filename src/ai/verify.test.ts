import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { RunsRepository } from '../data/runsRepository';
import { ProviderRepository } from '../data/providerRepository';
import { SpendRepository } from '../data/spendRepository';
import { ViolationsRepository } from '../data/violationsRepository';
import { LawsRepository, type Law } from '../data/lawsRepository';
import { EncryptedCredentialStore, MemoryVault } from './credentials';
import { Verifier } from './verify';
import { ProviderError, type ChatDelta, type ProviderAdapter } from './provider';
import type { BriefLaw } from '../domain/lawsAndBans';
import { buildBanList } from '../text/repetition';

/**
 * The states the verifier has to name rather than skip. The happy path and
 * the no-model path run inside `draft.test.ts`, where the draft is real.
 * Fixtures invented — D14.
 */

const P = 'p1';
let driver: NodeSqlDriver;
let runs: RunsRepository;
let providers: ProviderRepository;
let spend: SpendRepository;
let violations: ViolationsRepository;
let credentials: EncryptedCredentialStore;
let accountId: string;
let law: Law;
let runId: string;

const asBrief = (l: Law): BriefLaw => ({
  id: l.id, scopeType: l.scopeType, category: l.category, severity: l.severity, title: l.title,
  ruleText: l.ruleText, examplesGood: null, examplesBad: null, isSystem: false,
  checkMode: l.checkMode, checkConfig: l.checkConfig,
});

function fake(deltas: ChatDelta[], error?: Error): { adapter: ProviderAdapter; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    adapter: {
      id: 'fake', listModels: async () => [], countTokens: (t) => t.length,
      capabilities: () => ({
        contextWindow: 8000, supportsTools: false, supportsJsonSchema: false, supportsStrictSchema: false,
        costIn: null, costOut: null, reasoningAllowance: 0,
      }),
      async *chat() {
        asked.push(1);
        for (const d of deltas) yield d;
        if (error) throw error;
      },
    },
  };
}

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  runs = new RunsRepository(driver);
  providers = new ProviderRepository(driver);
  spend = new SpendRepository(driver, runs);
  violations = new ViolationsRepository(driver);
  credentials = new EncryptedCredentialStore(new MemoryVault());
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [P, 'P'], 'run');
  const account = await providers.addAccount({ kind: 'openrouter', label: 'Mine' });
  accountId = account.id;
  await providers.setProfile(P, 'critique', { providerAccountId: accountId, modelId: 'fake/cheap' });
  law = await new LawsRepository(driver).create(P, {
    title: 'No weather', ruleText: 'Do not open on weather.', category: 'style', checkMode: 'rubric',
  });
  runId = await runs.start(P, {
    sceneId: null, purpose: 'draft_beat', provider: 'openrouter', model: 'm', params: {}, briefJson: '{}', promptRendered: '',
  });
});

async function verify(adapter: ProviderAdapter, text = 'The rain came down on the empty square.') {
  const v = new Verifier({ runs, providers, credentials, violations, spend, adapterFor: () => adapter });
  return v.verify({
    projectId: P, sceneId: null, runId, text, laws: [asBrief(law)], ban: buildBanList(''),
  }, new AbortController().signal);
}

async function withKey() {
  await credentials.save(accountId, 'sk-or-v1-fake');
  await providers.setCredentialRef(accountId, accountId);
}

describe('the rubric states', () => {
  it('says when the critique account has no key, without calling', async () => {
    const f = fake([]);
    const v = await verify(f.adapter);
    expect(v.rubric).toMatchObject({ state: 'no-key', laws: 1 });
    expect(v.rubric.detail).toContain('No key is saved');
    expect(f.asked).toHaveLength(0);
  });

  it('is refused by the spend stop like any other call, and the refusal is a blocked run', async () => {
    await withKey();
    await spend.setCaps(P, { warnUsd: 0, stopUsd: 0 });
    const f = fake([]);
    const v = await verify(f.adapter);
    expect(v.rubric.state).toBe('blocked');
    expect(v.rubric.detail).toContain('daily stop');
    expect(f.asked).toHaveLength(0);
    expect((await runs.list(P)).map((r) => [r.purpose, r.status])).toContainEqual(['critique', 'blocked']);
  });

  it('calls an unreadable answer malformed and keeps the run', async () => {
    await withKey();
    const f = fake([
      { kind: 'text', text: 'I found no problems with this passage.' },
      { kind: 'usage', promptTokens: 10, completionTokens: 10, reasoningTokens: 0 },
      { kind: 'done', finishReason: 'stop', servedBy: 'Cheap' },
    ]);
    const v = await verify(f.adapter);
    expect(v.rubric.state).toBe('malformed');
    expect(v.findings).toEqual([]);
    const run = (await runs.list(P)).find((r) => r.purpose === 'critique');
    expect(run).toMatchObject({ status: 'ok', outputText: 'I found no problems with this passage.' });
  });

  it('reports a refusal and a failure as such, with the run closed the same way', async () => {
    await withKey();
    const refused = await verify(fake([], new ProviderError('refused', 'Nope', 403)).adapter);
    expect(refused.rubric).toMatchObject({ state: 'refused', detail: 'Nope' });
    const failed = await verify(fake([], new Error('boom')).adapter);
    expect(failed.rubric).toMatchObject({ state: 'failed', detail: 'boom' });
    expect((await runs.list(P)).filter((r) => r.purpose === 'critique').map((r) => r.status).sort())
      .toEqual(['error', 'refused']);
  });

  it('strips a reasoning block before reading the array, and learns the reasoning spend', async () => {
    await withKey();
    const f = fake([
      { kind: 'text', text: '<think>Let me look.</think>[{"law":1,"quote":"The rain came down","why":"Weather.","fix":""}]' },
      { kind: 'usage', promptTokens: 10, completionTokens: 10, reasoningTokens: 700 },
      { kind: 'done', finishReason: 'stop', servedBy: 'Cheap' },
    ]);
    const v = await verify(f.adapter);
    expect(v.rubric.state).toBe('ran');
    expect(v.findings.map((x) => x.quote)).toEqual(['The rain came down']);
    expect((await providers.listProfiles(P)).find((p) => p.role === 'critique')?.reasoningAllowance).toBe(700);
  });
});
