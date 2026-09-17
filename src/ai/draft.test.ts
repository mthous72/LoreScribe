import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { BriefRepository } from '../data/briefRepository';
import { PlanRepository } from '../data/planRepository';
import { RunsRepository } from '../data/runsRepository';
import { ProviderRepository } from '../data/providerRepository';
import { ManuscriptRepository } from '../data/manuscriptRepository';
import { VersionsRepository } from '../data/versionsRepository';
import { SpendRepository } from '../data/spendRepository';
import { ViolationsRepository } from '../data/violationsRepository';
import { LawsRepository } from '../data/lawsRepository';
import { Verifier } from './verify';
import type { Finding } from '../domain/verify';
import { EncryptedCredentialStore, MemoryVault } from './credentials';
import {
  Drafter, NoDraftModelError, SpendCapError, appendParagraphs, renderDraftPrompt, type DraftEvent,
} from './draft';
import { ProviderError, type ChatDelta, type ChatRequest, type ProviderAdapter } from './provider';

/**
 * Drafting a beat against the real database with a fake provider.
 *
 * What the fake lets us prove is the shape around the call, which is where
 * the promises are: the brief is compiled at the model's window and stored on
 * the run, a reasoning block split across two chunks never reaches the screen,
 * the run closes with tokens and cost and who served it, the worst reasoning
 * spend is learned, cancellation keeps what arrived, and nothing lands in the
 * scene until accepted — and then only after a snapshot.
 *
 * Fixtures invented — D14.
 */

const P = 'p1';
let driver: NodeSqlDriver;
let manuscript: ManuscriptRepository;
let providers: ProviderRepository;
let runs: RunsRepository;
let versions: VersionsRepository;
let plan: PlanRepository;
let spend: SpendRepository;
let violations: ViolationsRepository;
let sceneId: string;
let beatId: string;
let profileId: string;

/** A fake adapter that plays back deltas, and records what it was asked. */
function fake(
  script: ChatDelta[] | ((req: ChatRequest) => ChatDelta[]),
  opts: { throwAfter?: number; error?: Error } = {},
) {
  const asked: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    id: 'fake',
    listModels: async () => [],
    capabilities: () => ({
      contextWindow: 8000, supportsTools: false, supportsJsonSchema: false, supportsStrictSchema: false,
      costIn: null, costOut: null, reasoningAllowance: 0,
    }),
    countTokens: (t) => t.length,
    async *chat(req, signal) {
      asked.push(req);
      const deltas = typeof script === 'function' ? script(req) : script;
      let i = 0;
      for (const d of deltas) {
        if (signal.aborted) { yield { kind: 'done', finishReason: 'cancelled', servedBy: 'Fake' }; return; }
        if (opts.throwAfter !== undefined && i === opts.throwAfter) throw opts.error ?? new Error('boom');
        yield d;
        i++;
      }
    },
  };
  return { adapter, asked };
}

const text = (t: string): ChatDelta => ({ kind: 'text', text: t });
const finished = (out = 60, reasoning = 0): ChatDelta[] => [
  { kind: 'usage', promptTokens: 1200, completionTokens: out, reasoningTokens: reasoning },
  { kind: 'done', finishReason: 'stop', servedBy: 'Fake' },
];

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  manuscript = new ManuscriptRepository(driver);
  providers = new ProviderRepository(driver);
  runs = new RunsRepository(driver);
  versions = new VersionsRepository(driver, manuscript);
  plan = new PlanRepository(driver);
  spend = new SpendRepository(driver, runs);
  violations = new ViolationsRepository(driver);
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [P, 'P'], 'run');
  const book = await manuscript.createBook(P, 'Book');
  const chapter = await manuscript.createChapter(book.id, 'One');
  const scene = await manuscript.createScene(chapter.id, 'The gate');
  sceneId = scene.id;
  await manuscript.saveSceneContent(sceneId, { contentText: 'She waited at the gate.\n\nNobody came.' });
  await manuscript.updateScene(sceneId, { summary: 'She waits.' });
  const arc = await plan.createArc(book.id, 'The seal');
  const beat = await plan.createBeat(arc.id, 'She is asked directly');
  await plan.updateBeat(beat.id, { summary: 'And does not answer.' });
  await plan.linkBeat(beat.id, sceneId, 'payoff');
  beatId = beat.id;
  const account = await providers.addAccount({ kind: 'openrouter', label: 'Mine' });
  await providers.setCredentialRef(account.id, account.id);
  const profile = await providers.setProfile(P, 'draft', {
    providerAccountId: account.id, modelId: 'fake/model', contextWindow: 8000, costInPerMtok: 3, costOutPerMtok: 15,
  });
  profileId = profile.id;
});

async function drafter(
  adapter: ProviderAdapter, withKey = true, critique: ProviderAdapter = fake(['[]' as never]).adapter,
) {
  const credentials = new EncryptedCredentialStore(new MemoryVault());
  const [account] = await providers.listAccounts();
  if (withKey) await credentials.save(account!.id, 'sk-or-v1-fake');
  const verifier = new Verifier({
    runs, providers, credentials, violations, spend, adapterFor: () => critique,
  });
  return new Drafter({
    brief: new BriefRepository(driver), plan, runs, providers, credentials, manuscript, versions, spend,
    verifier, adapterFor: () => adapter,
  });
}

async function collect(d: Drafter, beat: string | null, signal = new AbortController().signal) {
  const events: DraftEvent[] = [];
  const request = { projectId: P, sceneId, beatId: beat, targetWords: 300 };
  for await (const ev of d.draft(request, signal)) events.push(ev);
  return events;
}

describe('the request', () => {
  it('sends the brief as the system prompt and the beat as the instruction, sized to the profile', async () => {
    const { adapter, asked } = fake([text('The clerk asked.'), ...finished()]);
    const d = await drafter(adapter);
    const events = await collect(d, beatId);

    const brief = events.find((e) => e.kind === 'brief');
    expect(brief).toMatchObject({ kind: 'brief', model: 'fake/model', window: 8000 });
    const [req] = asked;
    expect(req?.model).toBe('fake/model');
    expect(req?.messages[0]?.role).toBe('system');
    expect(req?.messages[0]?.content).toContain('=== SCENE ===');
    expect(req?.messages[0]?.content).toContain('=== BEATS ===');
    expect(req?.messages[1]?.content)
      .toContain('She is asked directly. And does not answer.');
    expect(req?.messages[1]?.content)
      .toContain('Continue directly from where the prose under STORY SO FAR ends');
    expect(req?.messages[1]?.content).toContain('About 300 words.');
    expect(req?.maxTokens).toBe(Math.ceil(300 * 1.6));
    expect(req?.dataPolicy).toBe('no_training');
  });

  it('adds the learned reasoning allowance to the budget up front', async () => {
    await providers.recordReasoning(profileId, 900);
    const { adapter, asked } = fake([text('x'), ...finished()]);
    await collect(await drafter(adapter), beatId);
    expect(asked[0]?.maxTokens).toBe(Math.ceil(300 * 1.6) + 900);
  });

  it('says when there is no draft model, and when the key is missing', async () => {
    await driver.query('DELETE FROM model_profile', [], 'run');
    const d = await drafter(fake([]).adapter);
    await expect(collect(d, null)).rejects.toBeInstanceOf(NoDraftModelError);
  });

  it('falls back to the default model when the role has none of its own', async () => {
    await driver.query('DELETE FROM model_profile', [], 'run');
    const [account] = await providers.listAccounts();
    await providers.setProfile(null, 'default', { providerAccountId: account!.id, modelId: 'fake/everything', contextWindow: 4000 });
    const { adapter, asked } = fake([text('x'), ...finished()]);
    const events = await collect(await drafter(adapter), beatId);
    expect(asked[0]?.model).toBe('fake/everything');
    expect(events.find((e) => e.kind === 'brief')).toMatchObject({ model: 'fake/everything', window: 4000 });
    // A role of its own wins over the default.
    await providers.setProfile(P, 'draft', { providerAccountId: account!.id, modelId: 'fake/strong' });
    await collect(await drafter(adapter), beatId);
    expect(asked[1]?.model).toBe('fake/strong');
  });

  it('refuses without a saved key', async () => {
    const d = await drafter(fake([]).adapter, false);
    await expect(collect(d, null)).rejects.toThrow(/No key is saved/);
  });
});

describe('the spend cap', () => {
  /** A priced run earlier today. */
  async function spent(costUsd: number) {
    const id = await runs.start(P, {
      sceneId, purpose: 'draft_beat', provider: 'openrouter', model: 'm', params: {}, briefJson: '{}', promptRendered: '',
    });
    await runs.finish(id, {
      outputText: 'x', tokensIn: 1, tokensOut: 1, tokensReasoning: 0, costUsd, latencyMs: 1, status: 'ok', servedBy: null,
    });
  }

  it('refuses before the call once today has reached the stop, and records the refusal', async () => {
    await spent(12);
    await spent(8);
    const { adapter, asked } = fake([text('never'), ...finished()]);
    const d = await drafter(adapter);
    const failure = await collect(d, beatId).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SpendCapError);
    expect((failure as SpendCapError).meter).toMatchObject({ todayUsd: 20, level: 'stop' });
    expect((failure as Error).message).toContain('$20.00 spent today');
    expect((failure as Error).message).toContain('$20.00 daily stop');
    expect(asked).toHaveLength(0);

    const [blocked] = await runs.list(P, sceneId);
    expect(blocked).toMatchObject({ status: 'blocked', costUsd: null, purpose: 'draft_beat' });
    expect(blocked?.blockReason).toContain('daily stop');
    // The refusal is not itself spend: the meter reads the same after it.
    expect((await spend.meter(P)).todayUsd).toBeCloseTo(20);
  });

  it('comes before the model lookup, so a project with no model is still told about its spend', async () => {
    await driver.query('DELETE FROM model_profile', [], 'run');
    await spent(25);
    await expect(collect(await drafter(fake([]).adapter), null)).rejects.toBeInstanceOf(SpendCapError);
  });

  it('continues past the warning, and honours a raised stop', async () => {
    await spent(19.99);
    const { adapter, asked } = fake([text('Still writing.'), ...finished()]);
    const d = await drafter(adapter);
    expect((await spend.meter(P)).level).toBe('warn');
    await collect(d, beatId);
    expect(asked).toHaveLength(1);

    // That run crossed the line; the next is refused until the stop moves.
    await spent(0.5);
    await expect(collect(d, beatId)).rejects.toBeInstanceOf(SpendCapError);
    await spend.setCaps(P, { warnUsd: 5, stopUsd: 40 });
    await collect(d, beatId);
    expect(asked).toHaveLength(2);
  });
});

describe('the stream', () => {
  it('strips a reasoning block split across chunks and records the run', async () => {
    const { adapter } = fake([
      text('<thi'), text('nk>Let me plan the beat.</th'), text('ink>She said nothing. '),
      text('The clerk waited.'), ...finished(40, 12),
    ]);
    const events = await collect(await drafter(adapter), beatId);
    const shown = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');
    expect(shown).toBe('She said nothing. The clerk waited.');
    expect(shown).not.toContain('think');

    const done = events.find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;
    expect(done).toMatchObject({
      status: 'ok', output: 'She said nothing. The clerk waited.', words: 6,
      tokensIn: 1200, tokensOut: 40, servedBy: 'Fake',
    });
    expect(done.costUsd).toBeCloseTo((1200 * 3 + 40 * 15) / 1_000_000);

    const run = await runs.get(done.runId);
    expect(run).toMatchObject({
      purpose: 'draft_beat', provider: 'openrouter', model: 'fake/model', status: 'ok',
      tokensReasoning: 12, servedBy: 'Fake', accepted: false, sceneId,
    });
    const row = ((await driver.query(
      'SELECT brief_json, prompt_rendered FROM ai_run WHERE id = ?', [done.runId], 'all')).rows as string[][])[0]!;
    expect(JSON.parse(row[0]!).text).toContain('=== SCENE ===');
    expect(row[1]).toContain('She is asked directly');
    // The worst reasoning spend is kept for next time.
    expect((await providers.listProfiles(P))[0]?.reasoningAllowance).toBe(12);
    // Nothing landed in the scene.
    expect((await manuscript.getSceneContent(sceneId))?.contentText).toBe('She waited at the gate.\n\nNobody came.');
  });

  it('keeps what arrived when cancelled, and says so', async () => {
    const ctl = new AbortController();
    const { adapter } = fake([text('First sentence. '), text('Second.'), ...finished()]);
    const d = await drafter(adapter);
    const events: DraftEvent[] = [];
    for await (const ev of d.draft({ projectId: P, sceneId, beatId, targetWords: 300 }, ctl.signal)) {
      events.push(ev);
      if (ev.kind === 'text') ctl.abort();
    }
    const done = events.find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;
    expect(done.status).toBe('cancelled');
    expect(done.output).toBe('First sentence.');
    expect((await runs.get(done.runId))?.status).toBe('cancelled');
  });

  it('closes a refusal as refused, keeping what came before it, without throwing', async () => {
    // A refusal is an answer, not a failure: the run says who declined, and
    // the panel says so in a sentence rather than an error.
    const refused = fake([text('Par'), text('never')], {
      throwAfter: 1, error: new ProviderError('refused', 'Nope', 403),
    });
    const events = await collect(await drafter(refused.adapter), beatId);
    const done = events.find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;
    expect(done.status).toBe('refused');
    const [run] = await runs.list(P, sceneId);
    expect(run).toMatchObject({ status: 'refused', errorText: 'Nope', outputText: 'Par' });
  });

  it('closes any other failure as an error on the run, then throws it', async () => {
    const broken = fake([text('Par'), text('never')], { throwAfter: 1, error: new Error('boom') });
    await expect(collect(await drafter(broken.adapter), beatId)).rejects.toThrow('boom');
    const [run] = await runs.list(P, sceneId);
    expect(run).toMatchObject({ status: 'error', errorText: 'boom', outputText: 'Par' });
  });

  it('calls a length stop truncated', async () => {
    const { adapter } = fake([text('Cut off mid'), { kind: 'usage', promptTokens: 1, completionTokens: 480, reasoningTokens: 0 },
      { kind: 'done', finishReason: 'length', servedBy: null }]);
    const events = await collect(await drafter(adapter), beatId);
    expect((events.find((e) => e.kind === 'done') as { status: string }).status).toBe('truncated');
  });
});

describe('the verdict', () => {
  it('follows done, carries the free checks, and says when the rubric laws had no model', async () => {
    const laws = new LawsRepository(driver);
    await laws.create(P, {
      title: 'No suddenly', ruleText: 'Never write "suddenly".', category: 'style',
      checkMode: 'regex', checkConfig: JSON.stringify({ pattern: '\\bsuddenly\\b', fix: 'Cut it.' }),
    });
    await laws.create(P, { title: 'No weather', ruleText: 'Do not open on weather.', category: 'style', checkMode: 'rubric' });
    const { adapter } = fake([text('Suddenly the clerk looked up. '), text('Then suddenly away.'), ...finished()]);
    const events = await collect(await drafter(adapter), beatId);
    expect(events.map((e) => e.kind).slice(-2)).toEqual(['done', 'verdict']);
    const { verdict } = events.at(-1) as Extract<DraftEvent, { kind: 'verdict' }>;
    expect(verdict.findings.map((f: Finding) => [f.lawTitle, f.quote, f.suggestedFix]))
      .toEqual([['No suddenly', 'Suddenly', 'Cut it.'], ['No suddenly', 'suddenly', 'Cut it.']]);
    expect(verdict.rubric).toMatchObject({ state: 'no-model', laws: 1 });
    expect(verdict.rubric.detail).toContain('No critique model');
    // Stored against the draft run.
    const done = events.find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;
    expect((await violations.listForRun(done.runId)).map((v) => v.start)).toEqual([0, 35]);
  });

  it('runs the rubric laws through the critique model, verifying every quote', async () => {
    const laws = new LawsRepository(driver);
    const law = await laws.create(P, {
      title: 'No adverb tags', ruleText: 'No adverbs on dialogue tags.', category: 'style', checkMode: 'prompt+rubric',
    });
    const [account] = await providers.listAccounts();
    await providers.setProfile(P, 'critique', {
      providerAccountId: account!.id, modelId: 'fake/cheap', costInPerMtok: 0.1, costOutPerMtok: 0.4,
    });
    const critique = fake((req) => {
      expect(req.model).toBe('fake/cheap');
      expect(req.messages[0]?.content).toContain('1. No adverb tags: No adverbs on dialogue tags.');
      expect(req.messages[0]?.content).toContain('PASSAGE\n"Go," he said quietly.');
      return [
        text('[{"law":1,"quote":"he said quietly","why":"Quietly.","fix":"Cut it."},'),
        text('{"law":1,"quote":"she whispered softly","why":"Invented.","fix":""}]'),
        { kind: 'usage', promptTokens: 500, completionTokens: 60, reasoningTokens: 0 },
        { kind: 'done', finishReason: 'stop', servedBy: 'Cheap' },
      ];
    });
    const { adapter } = fake([text('"Go," he said quietly. The door closed.'), ...finished()]);
    const events = await collect(await drafter(adapter, true, critique.adapter), beatId);
    const { verdict } = events.at(-1) as Extract<DraftEvent, { kind: 'verdict' }>;
    expect(verdict.rubric.state).toBe('ran');
    expect(verdict.rubric.costUsd).toBeCloseTo((500 * 0.1 + 60 * 0.4) / 1_000_000);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ lawId: law.id, quote: 'he said quietly', start: 6, end: 21, source: 'rubric' });
    expect(verdict.uncertain.map((u: Finding) => u.quote)).toEqual(['she whispered softly']);

    const critiqueRun = (await runs.list(P, sceneId)).find((r) => r.purpose === 'critique');
    expect(critiqueRun).toMatchObject({ model: 'fake/cheap', status: 'ok', servedBy: 'Cheap' });
    const done = events.find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;
    const rows = await violations.listForRun(done.runId);
    expect(rows.map((r) => [r.evidenceVerified, r.quote])).toEqual([[true, 'he said quietly'], [false, 'she whispered softly']]);
  });

  it('spends nothing on critique when the writer stopped the draft, and none when there is no rubric law', async () => {
    await new LawsRepository(driver).create(P, { title: 'r', ruleText: 'r', category: 'style', checkMode: 'rubric' });
    const critique = fake([text('[]'), ...finished()]);
    const ctl = new AbortController();
    const { adapter } = fake([text('First sentence. '), text('Second.'), ...finished()]);
    const d = await drafter(adapter, true, critique.adapter);
    const events: DraftEvent[] = [];
    for await (const ev of d.draft({ projectId: P, sceneId, beatId, targetWords: 300 }, ctl.signal)) {
      events.push(ev);
      if (ev.kind === 'text') ctl.abort();
    }
    expect((events.at(-1) as Extract<DraftEvent, { kind: 'verdict' }>).verdict.rubric.state).toBe('cancelled');
    expect(critique.asked).toHaveLength(0);

    await driver.query('DELETE FROM law', [], 'run');
    const again = await collect(d, beatId);
    expect((again.at(-1) as Extract<DraftEvent, { kind: 'verdict' }>).verdict.rubric).toMatchObject({ state: 'no-laws', laws: 0 });
  });

  it('reports a verifier failure in the verdict rather than losing the draft', async () => {
    const broken = new Verifier({
      runs, providers, credentials: new EncryptedCredentialStore(new MemoryVault()),
      violations: { record: async () => { throw new Error('disk gone'); } } as unknown as ViolationsRepository,
      spend,
    });
    const credentials = new EncryptedCredentialStore(new MemoryVault());
    const [account] = await providers.listAccounts();
    await credentials.save(account!.id, 'sk-or-v1-fake');
    const { adapter } = fake([text('Fine prose.'), ...finished()]);
    const d = new Drafter({
      brief: new BriefRepository(driver), plan, runs, providers, credentials, manuscript, versions, spend,
      verifier: broken, adapterFor: () => adapter,
    });
    const events = await collect(d, beatId);
    expect((events.find((e) => e.kind === 'done') as { output: string }).output).toBe('Fine prose.');
    expect((events.at(-1) as Extract<DraftEvent, { kind: 'verdict' }>).verdict.rubric).toMatchObject({
      state: 'failed', detail: 'disk gone',
    });
  });
});

describe('accepting', () => {
  it('snapshots the page, appends the beat, and marks the run accepted', async () => {
    const { adapter } = fake([text('She said nothing.\n\nThe clerk waited.'), ...finished()]);
    const d = await drafter(adapter);
    const done = (await collect(d, beatId)).find((e) => e.kind === 'done') as Extract<DraftEvent, { kind: 'done' }>;

    const { words } = await d.accept(done.runId, sceneId);
    const content = await manuscript.getSceneContent(sceneId);
    expect(content?.contentText).toBe('She waited at the gate.\n\nNobody came.\n\nShe said nothing.\n\nThe clerk waited.');
    expect(words).toBe(13);
    const doc = JSON.parse(content!.contentJson!) as { content: { type: string }[] };
    expect(doc.content.filter((n) => n.type === 'paragraph').length).toBeGreaterThanOrEqual(2);

    const kept = await versions.list(sceneId);
    expect(kept.some((v) => v.label === 'before the drafted beat')).toBe(true);
    expect((await runs.get(done.runId))?.accepted).toBe(true);
  });

  it('refuses to accept a run with nothing in it', async () => {
    const d = await drafter(fake([]).adapter);
    const id = await runs.start(P, {
      sceneId, purpose: 'draft_beat', provider: 'x', model: 'y', params: {}, briefJson: '{}', promptRendered: '',
    });
    await expect(d.accept(id, sceneId)).rejects.toThrow(/nothing to accept/);
  });
});

describe('the pieces', () => {
  it('renders an instruction with and without a beat, and for an empty scene', () => {
    const beat = { beatId: 'b', arcId: 'a', arcName: 'A', arcColour: null, title: 'She lies', summary: null, function: null, role: 'develop' };
    expect(renderDraftPrompt(beat, 150, true)).toContain('Write the next beat of this scene: She lies.\n');
    expect(renderDraftPrompt(null, 150, false)).toContain('This is the opening of the scene.');
    expect(renderDraftPrompt(null, 150, false)).not.toContain('STORY SO FAR');
  });

  it('appends paragraphs to a document, or starts one', () => {
    const doc = appendParagraphs(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }), 'a\n\nb') as {
      content: unknown[];
    };
    expect(doc.content).toHaveLength(3);
    expect((appendParagraphs(null, 'only') as { content: unknown[] }).content).toHaveLength(1);
    expect((appendParagraphs('not json', 'x') as { content: unknown[] }).content).toHaveLength(1);
  });
});
