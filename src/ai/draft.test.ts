import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { BriefRepository } from '../data/briefRepository';
import { PlanRepository } from '../data/planRepository';
import { RunsRepository } from '../data/runsRepository';
import { ProviderRepository } from '../data/providerRepository';
import { ManuscriptRepository } from '../data/manuscriptRepository';
import { VersionsRepository } from '../data/versionsRepository';
import { EncryptedCredentialStore, MemoryVault } from './credentials';
import { Drafter, NoDraftModelError, appendParagraphs, renderDraftPrompt, type DraftEvent } from './draft';
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

async function drafter(adapter: ProviderAdapter, withKey = true) {
  const credentials = new EncryptedCredentialStore(new MemoryVault());
  const [account] = await providers.listAccounts();
  if (withKey) await credentials.save(account!.id, 'sk-or-v1-fake');
  return new Drafter({
    brief: new BriefRepository(driver), plan, runs, providers, credentials, manuscript, versions,
    adapterFor: () => adapter,
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

  it('refuses without a saved key', async () => {
    const d = await drafter(fake([]).adapter, false);
    await expect(collect(d, null)).rejects.toThrow(/No key is saved/);
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
