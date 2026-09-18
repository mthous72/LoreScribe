import type { CredentialStore } from './credentials';
import { explainProviderError } from './explain';
import { ProviderError, type ChatMessage, type ProviderAdapter } from './provider';
import { costOf, defaultAdapter, guardSpend, resolveRole, SpendCapError } from './roles';
import type { ModelProfile, ProviderAccount, ProviderRepository } from '../data/providerRepository';
import type { RunsRepository, RunStatus } from '../data/runsRepository';
import type { SpendRepository } from '../data/spendRepository';
import type { ImportRepository, PreparedProposal } from '../data/importRepository';
import {
  chunkDocument, mergeExtracted, mergeRecommendations, parseExtractReply, renderExtractPrompt,
  type Chunk, type ExtractTypes, type Extracted, type Recommendation,
} from '../domain/extract';
import type { SourceDoc } from '../import/source';
import { stripReasoningBlocks } from '../text/sanitise';

/**
 * The extraction lane, run: a bible's files read by the `extract` role and
 * staged as proposals for the import review.
 *
 * One call per chunk ([`chunkDocument`](../domain/extract.ts)), each its own
 * `ai_run`, each under the spend cap — a forty-file bible that trips the stop
 * halfway stops halfway, with what it has read so far staged and the rest
 * named. The role is `extract`, the cheap one; there is no fall-back to the
 * draft model. Progress is streamed as events so the screen can show which
 * file is being read and what came of it.
 *
 * **Every chunk ends in a named state**, and the screen shows all of them,
 * whether or not anything was staged: a pass that finds nothing must say
 * why, file by file, or the writer is left looking at a blank. Two states a
 * small free model produces often get a second attempt, once (doc 12's
 * rule: one retry, not a loop): an answer in the wrong shape is asked for
 * again with the instruction made firmer, and an answer **cut off** — a
 * reasoning model spending the room on thinking — is asked for again with
 * twice the room, the allowance it just taught us included.
 *
 * Every proposal reaches the stager with its evidence checked. The run is
 * staged with accept-all applied to the verified rows, so the review opens
 * with the trustworthy ones ready and the unverified ones waiting, greyed,
 * for a writer's own decision.
 */

export type ChunkState =
  | 'ok' | 'empty' | 'malformed' | 'truncated' | 'refused' | 'failed' | 'blocked' | 'cancelled';

export interface ChunkOutcome {
  index: number;
  label: string;
  state: ChunkState;
  proposals: number;
  costUsd: number | null;
  /** The last `ai_run` made for it, whose `output_text` is what the model said. */
  runId: string | null;
  /** A sentence for the screen when the state needs one. */
  detail: string | null;
  /** How many calls it took. */
  attempts: number;
}

/** What is on the wire right now, so a slow model never looks like a stuck one. */
export interface LiveCall {
  index: number;
  label: string;
  attempt: number;
  /** Words of source in this chunk, and the room given for the answer. */
  words: number;
  maxTokens: number;
  /** Characters of answer received so far, reasoning excluded. */
  chars: number;
  /** The model has sent reasoning — it is thinking, not silent. */
  reasoning: boolean;
}

export type ExtractEvent =
  | { kind: 'plan'; chunks: number; files: number; tokens: number }
  /** A call has just gone out. */
  | ({ kind: 'sending' } & LiveCall)
  /** Something has come back; sent at most a few times a second. */
  | ({ kind: 'receiving' } & LiveCall)
  | ({ kind: 'chunk' } & ChunkOutcome)
  | {
    kind: 'done';
    runId: string | null;
    proposals: number;
    unverified: number;
    dropped: { what: string; reason: string }[];
    /** Where the schema fell short of the files: new types, new fields, material with no home. */
    recommendations: Recommendation[];
    /** Chunks that did not produce proposals, and why. */
    problems: ChunkOutcome[];
    costUsd: number;
  };

export interface ExtractorDeps {
  runs: RunsRepository;
  providers: ProviderRepository;
  credentials: CredentialStore;
  spend: SpendRepository;
  imports: ImportRepository;
  adapterFor?: (account: ProviderAccount, apiKey: string) => ProviderAdapter;
}

const PURPOSE = 'extract';
/** The answer is a list of the source's contents: roughly a third of it, never less than a page. */
const OUTPUT_RATIO = 0.4;
const MIN_TOKENS = 800;
/** How often at most a `receiving` event goes out while an answer streams. */
const RECEIVING_EVERY_MS = 400;
const FIRMER = '\n\nYour previous answer was not one JSON object. Reply with only the JSON object described above: '
  + 'no explanation, no code fence, nothing before the opening brace or after the closing one.';

interface Call {
  runId: string;
  status: RunStatus;
  reply: string;
  costUsd: number | null;
  errorText: string | null;
  explained: string | null;
}

export class Extractor {
  constructor(private readonly deps: ExtractorDeps) {}

  /** What one pass would send, before it is sent. */
  plan(docs: readonly SourceDoc[]): Chunk[] {
    return docs.flatMap((d) => chunkDocument(d));
  }

  async *extract(
    projectId: string, docs: readonly SourceDoc[], types: ExtractTypes, signal: AbortSignal,
  ): AsyncIterable<ExtractEvent> {
    const chunks = this.plan(docs);
    yield {
      kind: 'plan', chunks: chunks.length, files: docs.length,
      tokens: chunks.reduce((n, c) => n + Math.ceil(c.text.length / 4), 0),
    };

    // The role and the key once; the spend guard before every call.
    const { profile, account } = await resolveRole(this.deps.providers, projectId, PURPOSE);
    const apiKey = account.credentialRef ? await this.deps.credentials.load(account.credentialRef) : null;
    if (!apiKey) throw new Error(`No key is saved for ${account.label} on this device.`);
    const adapter = (this.deps.adapterFor ?? defaultAdapter)(account, apiKey);

    const gathered: Extracted[] = [];
    const recommended: Recommendation[] = [];
    const dropped: { what: string; reason: string }[] = [];
    const problems: ChunkOutcome[] = [];
    let firstRunId: string | null = null;
    let cost = 0;
    let stopped = false;

    for (const [index, chunk] of chunks.entries()) {
      const outcome: ChunkOutcome = {
        index, label: chunk.label, state: 'ok', proposals: 0, costUsd: null, runId: null, detail: null, attempts: 0,
      };
      const finish = (state: ChunkState, detail: string | null = null) => {
        outcome.state = state;
        outcome.detail = detail;
        if (state !== 'ok') problems.push(outcome);
        return { kind: 'chunk' as const, ...outcome };
      };

      if (stopped || signal.aborted) {
        yield finish(stopped ? 'blocked' : 'cancelled', stopped ? 'not sent: the spend stop above' : null);
        continue;
      }

      const basePrompt = renderExtractPrompt(chunk, types);
      let maxTokens = Math.max(MIN_TOKENS, Math.ceil(chunk.text.length / 4 * OUTPUT_RATIO))
        + profile.reasoningAllowance;
      let prompt = basePrompt;
      let result: ReturnType<typeof parseExtractReply> | null = null;
      let last: Call | null = null;

      // At most two attempts: the first, and one more for the two states a
      // firmer ask or more room can fix.
      for (let attempt = 1; attempt <= 2 && !result; attempt++) {
        try {
          await guardSpend(this.deps, projectId, null, PURPOSE);
        } catch (e) {
          if (!(e instanceof SpendCapError)) throw e;
          stopped = true;
          last = null;
          break;
        }
        outcome.attempts = attempt;
        const call = this.#call(
          projectId, profile, account, adapter, chunk, prompt, maxTokens, attempt, index, signal);
        // The call is a generator so its progress can be yielded live; its
        // return value is the closed call.
        let step = await call.next();
        while (!step.done) { yield step.value; step = await call.next(); }
        last = step.value;
        outcome.runId = last.runId;
        firstRunId ??= last.runId;
        cost += last.costUsd ?? 0;
        outcome.costUsd = (outcome.costUsd ?? 0) + (last.costUsd ?? 0);

        if (last.status !== 'ok' && last.status !== 'truncated') break;
        const parsed = parseExtractReply(last.reply, chunk, types);
        if (!parsed.malformed) { result = parsed; break; }
        if (attempt === 2) break;
        // Cut off: twice the room, and the allowance the first answer just
        // taught the profile. Wrong shape: the same ask, put more firmly.
        if (last.status === 'truncated') {
          const learned = (await this.deps.providers.listProfiles(projectId))
            .find((p) => p.id === profile.id)?.reasoningAllowance ?? profile.reasoningAllowance;
          maxTokens = maxTokens * 2 + learned;
        } else {
          prompt = basePrompt + FIRMER;
        }
      }

      if (stopped && !last) {
        yield finish('blocked', 'today\'s spend has reached the stop; nothing more was sent');
        continue;
      }
      if (!last) { yield finish('failed', 'nothing was sent'); continue; }

      if (last.status === 'error') { yield finish('failed', last.explained); continue; }
      if (last.status === 'refused') { yield finish('refused', last.explained ?? 'the provider declined'); continue; }
      if (last.status === 'cancelled') { yield finish('cancelled'); continue; }
      if (!result) {
        yield last.status === 'truncated'
          ? finish('truncated', 'the answer was cut off before it finished, twice; a reasoning model may be spending '
            + 'the room on thinking, or the section is too long for this model')
          : finish('malformed', 'the model did not answer with one JSON object, even when asked again; '
            + 'its reply is kept on the run');
        continue;
      }

      gathered.push(...result.proposals);
      recommended.push(...result.recommendations);
      dropped.push(...result.dropped);
      outcome.proposals = result.proposals.length;
      const recs = result.recommendations.length;
      yield result.proposals.length === 0
        ? finish('empty', recs
          ? `nothing staged, but ${recs} recommendation${recs === 1 ? '' : 's'} below`
          : result.dropped.length
            ? `nothing usable: ${result.dropped.length} item${result.dropped.length === 1 ? '' : 's'} dropped, listed below`
            : 'the model found nothing to propose in it')
        : finish('ok');
    }

    const merged = mergeExtracted(gathered);
    let stagedRun: string | null = null;
    if (merged.length > 0) {
      const rows: PreparedProposal[] = merged.map((p) => ({
        table: p.table, op: p.op, payload: p.payload, rationale: p.rationale,
        confidence: p.confidence, evidenceQuote: p.evidenceQuote, evidenceVerified: p.evidenceVerified,
      }));
      const { runId } = await this.deps.imports.stagePrepared(projectId, rows, firstRunId);
      await this.deps.imports.acceptAll(runId);
      stagedRun = runId;
    }
    yield {
      kind: 'done', runId: stagedRun, proposals: merged.length,
      unverified: merged.filter((p) => !p.evidenceVerified).length, dropped,
      recommendations: mergeRecommendations(recommended), problems, costUsd: cost,
    };
  }

  /** One call, one `ai_run`, closed however it ends; what is on the wire, yielded as it happens. */
  async *#call(
    projectId: string, profile: ModelProfile, account: ProviderAccount, adapter: ProviderAdapter,
    chunk: Chunk, prompt: string, maxTokens: number, attempt: number, index: number, signal: AbortSignal,
  ): AsyncGenerator<ExtractEvent, Call> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const live: LiveCall = {
      index, label: chunk.label, attempt, words: chunk.words, maxTokens, chars: 0, reasoning: false,
    };
    yield { kind: 'sending', ...live };
    const runId = await this.deps.runs.start(projectId, {
      sceneId: null, purpose: PURPOSE, provider: account.kind, model: profile.modelId,
      params: {
        maxTokens, temperature: 0, path: chunk.path, label: chunk.label, attempt,
        dataPolicy: account.dataPolicy,
      },
      briefJson: JSON.stringify({ label: chunk.label, words: chunk.words, attempt }),
      promptRendered: prompt,
    });

    const started = Date.now();
    let raw = '';
    let usage: { tokensIn: number; tokensOut: number; tokensReasoning: number } | null = null;
    let servedBy: string | null = null;
    let status: RunStatus = 'ok';
    let errorText: string | null = null;
    let explained: string | null = null;
    let lastSent = 0;
    try {
      for await (const delta of adapter.chat({
        model: profile.modelId, messages, maxTokens, temperature: 0, dataPolicy: account.dataPolicy,
      }, signal)) {
        if (delta.kind === 'text') {
          raw += delta.text;
          live.chars = raw.length;
        } else if (delta.kind === 'reasoning') {
          live.reasoning = true;
        }
        if (delta.kind === 'text' || delta.kind === 'reasoning') {
          const now = Date.now();
          if (now - lastSent >= RECEIVING_EVERY_MS || lastSent === 0) {
            lastSent = now;
            yield { kind: 'receiving', ...live };
          }
        }
        if (delta.kind === 'usage') {
          usage = {
            tokensIn: delta.promptTokens, tokensOut: delta.completionTokens,
            tokensReasoning: delta.reasoningTokens,
          };
        } else if (delta.kind === 'done') {
          servedBy = delta.servedBy;
          status = delta.finishReason === 'length' ? 'truncated'
            : delta.finishReason === 'cancelled' ? 'cancelled'
              : delta.finishReason === 'content_filter' ? 'refused' : 'ok';
        }
      }
    } catch (e) {
      status = e instanceof ProviderError && e.code === 'refused' ? 'refused' : 'error';
      errorText = (e as Error).message ?? String(e);
      explained = explainProviderError(e);
    }

    const reply = stripReasoningBlocks(raw);
    const costUsd = costOf(profile, usage);
    await this.deps.runs.finish(runId, {
      outputText: reply || null,
      tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
      tokensReasoning: usage?.tokensReasoning ?? null,
      costUsd, latencyMs: Date.now() - started, status, servedBy, errorText,
    });
    if (usage && usage.tokensReasoning > 0) {
      await this.deps.providers.recordReasoning(profile.id, usage.tokensReasoning);
    }
    return { runId, status, reply, costUsd, errorText, explained };
  }
}

/** Outcomes that read as one line: read files each on their own, the failures folded by reason. */
export interface OutcomeGroup {
  state: ChunkState;
  detail: string | null;
  outcomes: ChunkOutcome[];
}

/**
 * Fold outcomes with the same state and the same reason into one group, in
 * first-seen order. Eighteen files refused for one reason is one thing to
 * read, not eighteen; a file that was read keeps its own line, because its
 * count is the news.
 */
export function groupOutcomes(outcomes: readonly ChunkOutcome[]): OutcomeGroup[] {
  const groups: OutcomeGroup[] = [];
  const byKey = new Map<string, OutcomeGroup>();
  for (const o of outcomes) {
    if (o.state === 'ok') { groups.push({ state: o.state, detail: o.detail, outcomes: [o] }); continue; }
    const key = `${o.state}\u0000${o.detail ?? ''}`;
    const seen = byKey.get(key);
    if (seen) { seen.outcomes.push(o); continue; }
    const group = { state: o.state, detail: o.detail, outcomes: [o] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}
