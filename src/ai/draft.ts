import type { BriefRepository, SceneBriefResult } from '../data/briefRepository';
import type { PlanRepository, SceneBeat } from '../data/planRepository';
import type { RunsRepository, RunStatus } from '../data/runsRepository';
import type { ModelProfile, ProviderAccount, ProviderRepository } from '../data/providerRepository';
import type { ManuscriptRepository } from '../data/manuscriptRepository';
import type { VersionsRepository } from '../data/versionsRepository';
import type { SpendRepository } from '../data/spendRepository';
import { usd, type SpendMeter } from '../domain/spend';
import type { CredentialStore } from './credentials';
import { OpenRouterAdapter } from './openrouter';
import { ProviderError, type ChatMessage, type ProviderAdapter } from './provider';
import { ReasoningStripper, sanitise } from '../text/sanitise';
import { countWords } from '../text/words';

/**
 * Draft a beat — the first thing the compiler was built for.
 *
 * Beat-sized by default ([D29](../../docs/10-decisions.md)): the request names
 * one beat this scene carries, and the model is asked for that beat's prose,
 * continuing from where the scene ends. Not "write chapter 12" — doc 06 calls
 * that the reason AI prose reads like mush.
 *
 * The shape, in order:
 *
 * 0. **Read the spend meter** ([D17](../../docs/10-decisions.md)). Past the
 *    day's stop, nothing is compiled and nothing is sent: a `blocked` run is
 *    recorded with the reason and `SpendCapError` carries the meter to the
 *    panel, where the stop is one tap from raised. This comes before the model
 *    lookup because it is the one check that holds whatever else is missing.
 * 1. **Compile the brief** for this scene at the draft model's window, so the
 *    budget is the real one. The brief is the system prompt, verbatim; the
 *    beat and the length are the user turn. Templates as rows
 *    (`prompt_template`) come later; until then this is the one built-in.
 * 2. **Open the run before the call** — `ai_run` with the brief stored, so a
 *    call that dies mid-stream leaves a row that says so.
 * 3. **Stream**, through the reasoning stripper as it lands so a `<think>` tag
 *    split across two chunks never reaches the screen, and with the learned
 *    reasoning allowance added to `max_tokens` up front, because streaming
 *    cannot retry (doc 12 §4).
 * 4. **Sanitise the whole** at the end — the same pipeline every generated
 *    span passes through before it is stored or shown.
 * 5. **Close the run** with tokens, cost from the profile's prices, who served
 *    it, and a status; keep the worst reasoning spend seen on the profile.
 *
 * **Nothing lands in the scene until the writer accepts it**, and accepting
 * takes a snapshot first ([D24](../../docs/10-decisions.md)): the prose as it
 * stood is a kept draft, so a beat that read well in the box and badly on the
 * page is one restore away from gone. The draft is appended — a beat continues
 * the scene — and the editor reloads from the database it just changed, the
 * same path a restored draft takes.
 */

export interface DraftRequest {
  projectId: string;
  sceneId: string;
  /** One of the beats this scene carries. Null continues without a named target. */
  beatId: string | null;
  /** About this many words of prose. */
  targetWords?: number;
}

export type DraftEvent =
  | { kind: 'brief'; brief: SceneBriefResult; model: string; window: number }
  | { kind: 'text'; text: string }
  | {
    kind: 'done';
    runId: string;
    /** Sanitised, and what `accept` will append. */
    output: string;
    status: RunStatus;
    words: number;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    servedBy: string | null;
  };

export interface DrafterDeps {
  brief: BriefRepository;
  plan: PlanRepository;
  runs: RunsRepository;
  providers: ProviderRepository;
  credentials: CredentialStore;
  manuscript: ManuscriptRepository;
  versions: VersionsRepository;
  spend: SpendRepository;
  /** Injected for tests; the default builds the real adapter for the account. */
  adapterFor?: (account: ProviderAccount, apiKey: string) => ProviderAdapter;
}

const DEFAULT_WORDS = 300;
/** Tokens per word of English prose, erring long — the answer must not be cut off. */
const TOKENS_PER_WORD = 1.6;
const PURPOSE = 'draft_beat';

/** Nothing to draft with yet. The panel turns this into a link. */
export class NoDraftModelError extends Error {
  constructor() {
    super('No draft model is set for this project. Choose one on the Providers page.');
    this.name = 'NoDraftModelError';
  }
}

/**
 * The user turn. The brief is the system prompt and says everything about the
 * world; this says only what to do now. Short on purpose: an instruction
 * buried under restated context is the failure the brief's fences exist to
 * avoid.
 */
export function renderDraftPrompt(
  beat: SceneBeat | null, targetWords: number, sceneHasProse: boolean,
): string {
  const lines = [
    beat
      ? `Write the next beat of this scene: ${beat.title}.${beat.summary ? ` ${beat.summary.trim()}` : ''}`
      : 'Write the next beat of this scene.',
    sceneHasProse
      ? 'Continue directly from where the prose under STORY SO FAR ends, in the same voice.'
      : 'This is the opening of the scene.',
    `About ${targetWords} words.`,
    'Prose only: no heading, no title, no summary, no notes about what you did. '
    + 'Do not repeat the last sentence already written. Stop when the beat has landed.',
  ];
  return lines.join('\n');
}

/** Today's spend has reached the project's stop. The meter says by how much; the panel offers the raise. */
export class SpendCapError extends Error {
  constructor(readonly meter: SpendMeter) {
    super(`${usd(meter.todayUsd)} spent today on this project has reached the ${usd(meter.caps.stopUsd)} daily stop, `
      + 'so nothing was sent.');
    this.name = 'SpendCapError';
  }
}

export class Drafter {
  constructor(private readonly deps: DrafterDeps) {}

  /** The draft role's profile and account, or `NoDraftModelError`. */
  async draftModel(projectId: string): Promise<{ profile: ModelProfile; account: ProviderAccount }> {
    const profile = (await this.deps.providers.listProfiles(projectId)).find((p) => p.role === 'draft');
    if (!profile) throw new NoDraftModelError();
    const accounts = await this.deps.providers.listAccounts();
    const account = accounts.find((a) => a.id === profile.providerAccountId);
    if (!account || !account.active) throw new NoDraftModelError();
    return { profile, account };
  }

  async *draft(req: DraftRequest, signal: AbortSignal): AsyncIterable<DraftEvent> {
    const meter = await this.deps.spend.meter(req.projectId);
    if (meter.level === 'stop') {
      const error = new SpendCapError(meter);
      await this.deps.runs.block(req.projectId, {
        sceneId: req.sceneId, purpose: PURPOSE, provider: null, model: null, reason: error.message,
      });
      throw error;
    }
    const { profile, account } = await this.draftModel(req.projectId);
    if (!account.credentialRef) throw new Error(`No key is saved for ${account.label} on this device.`);
    const apiKey = await this.deps.credentials.load(account.credentialRef);
    if (!apiKey) throw new Error(`No key is saved for ${account.label} on this device.`);
    const adapter = (this.deps.adapterFor ?? defaultAdapter)(account, apiKey);

    const targetWords = req.targetWords ?? DEFAULT_WORDS;
    const window = profile.contextWindow ?? 32_000;
    const compiled = await this.deps.brief.compile(req.sceneId, { window });
    if (!compiled) throw new Error('That scene no longer exists.');
    yield { kind: 'brief', brief: compiled, model: profile.modelId, window };

    const beats = await this.deps.plan.beatsForScene(req.sceneId);
    const beat = req.beatId ? beats.find((b) => b.beatId === req.beatId) ?? null : null;
    const [content, details] = await Promise.all([
      this.deps.manuscript.getSceneContent(req.sceneId),
      this.deps.manuscript.getSceneDetails(req.sceneId),
    ]);
    const hasProse = !!content?.contentText?.trim();
    const instruction = renderDraftPrompt(beat, targetWords, hasProse);
    const messages: ChatMessage[] = [
      { role: 'system', content: compiled.brief.text },
      { role: 'user', content: instruction },
    ];
    const maxTokens = Math.ceil(targetWords * TOKENS_PER_WORD) + profile.reasoningAllowance;

    const runId = await this.deps.runs.start(req.projectId, {
      sceneId: req.sceneId, purpose: PURPOSE, provider: account.kind, model: profile.modelId,
      params: { maxTokens, targetWords, beatId: req.beatId, dataPolicy: account.dataPolicy },
      briefJson: JSON.stringify({ text: compiled.brief.text, sections: compiled.brief.sections }),
      promptRendered: `${compiled.brief.text}\n\n---\n\n${instruction}`,
    });

    const started = Date.now();
    const stripper = new ReasoningStripper();
    let raw = '';
    let shown = '';
    let usage: { tokensIn: number; tokensOut: number; tokensReasoning: number } | null = null;
    let servedBy: string | null = null;
    let status: RunStatus = 'ok';
    let errorText: string | null = null;

    try {
      for await (const delta of adapter.chat({
        model: profile.modelId, messages, maxTokens, dataPolicy: account.dataPolicy,
      }, signal)) {
        if (delta.kind === 'text') {
          raw += delta.text;
          const visible = stripper.push(delta.text);
          if (visible) { shown += visible; yield { kind: 'text', text: visible }; }
        } else if (delta.kind === 'usage') {
          usage = {
            tokensIn: delta.promptTokens, tokensOut: delta.completionTokens,
            tokensReasoning: delta.reasoningTokens,
          };
        } else if (delta.kind === 'done') {
          servedBy = delta.servedBy;
          status = statusOf(delta.finishReason);
        }
      }
      const tail = stripper.flush();
      if (tail) { shown += tail; yield { kind: 'text', text: tail }; }
    } catch (e) {
      status = e instanceof ProviderError && e.code === 'refused' ? 'refused' : 'error';
      errorText = (e as Error).message ?? String(e);
    }

    const output = sanitise(raw, { summary: details?.summary ?? undefined });
    const cost = usage && profile.costInPerMtok !== null && profile.costOutPerMtok !== null
      ? (usage.tokensIn * profile.costInPerMtok + usage.tokensOut * profile.costOutPerMtok) / 1_000_000
      : null;

    await this.deps.runs.finish(runId, {
      outputText: output || null,
      tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
      tokensReasoning: usage?.tokensReasoning ?? null,
      costUsd: cost, latencyMs: Date.now() - started, status, servedBy, errorText,
      sanitizerActions: {
        strippedReasoning: stripper.unterminated || shown.length !== raw.length,
        changed: output !== raw.trim(),
      },
    });
    if (usage && usage.tokensReasoning > 0) {
      await this.deps.providers.recordReasoning(profile.id, usage.tokensReasoning);
    }
    if (status === 'error' && errorText) throw new Error(errorText);

    yield {
      kind: 'done', runId, output, status, words: countWords(output).words,
      tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
      costUsd: cost, servedBy,
    };
  }

  /**
   * Put a draft into the scene, after keeping what was there.
   *
   * Appended, because a beat continues the scene. The snapshot is what makes
   * this reversible from the drafts panel; the editor is the caller's to
   * reload, the same way a restore is.
   */
  async accept(runId: string, sceneId: string): Promise<{ words: number }> {
    const run = await this.deps.runs.get(runId);
    if (!run?.outputText) throw new Error('There is nothing to accept from that run.');
    await this.deps.versions.snapshot(sceneId, { label: 'before the drafted beat', origin: 'manual' });

    const current = await this.deps.manuscript.getSceneContent(sceneId);
    const before = current?.contentText?.trim() ?? '';
    const text = before ? `${before}\n\n${run.outputText}` : run.outputText;
    const doc = appendParagraphs(current?.contentJson ?? null, run.outputText);
    const { wordCount } = await this.deps.manuscript.saveSceneContent(sceneId, {
      contentJson: JSON.stringify(doc), contentText: text,
    });
    await this.deps.runs.accept(runId);
    return { words: wordCount };
  }
}

function defaultAdapter(account: ProviderAccount, apiKey: string): ProviderAdapter {
  if (account.kind !== 'openrouter') {
    throw new Error(`${account.kind} accounts cannot draft yet; only OpenRouter can.`);
  }
  return new OpenRouterAdapter({
    apiKey, baseUrl: account.baseUrl ?? undefined,
    referer: typeof window === 'undefined' ? undefined : window.location.origin, title: 'LoreScribe',
  });
}

function statusOf(reason: string): RunStatus {
  switch (reason) {
    case 'stop': return 'ok';
    case 'length': return 'truncated';
    case 'cancelled': return 'cancelled';
    case 'content_filter': return 'refused';
    case 'error': return 'error';
    default: return 'ok';
  }
}

/** The scene's Tiptap document with the draft's paragraphs after its own. */
export function appendParagraphs(contentJson: string | null, text: string): object {
  let doc: { type: string; content?: unknown[] } = { type: 'doc', content: [] };
  if (contentJson) {
    try { doc = JSON.parse(contentJson) as typeof doc; } catch { /* start fresh */ }
  }
  const paragraphs = text.split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean).map((p) => ({
    type: 'paragraph', content: [{ type: 'text', text: p }],
  }));
  return { ...doc, content: [...(doc.content ?? []), ...paragraphs] };
}
