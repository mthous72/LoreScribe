import type { CredentialStore } from './credentials';
import { ProviderError, type ChatMessage, type ProviderAdapter } from './provider';
import { costOf, defaultAdapter, guardSpend, resolveRole, SpendCapError } from './roles';
import type { ProviderAccount, ProviderRepository } from '../data/providerRepository';
import type { RunsRepository, RunStatus } from '../data/runsRepository';
import type { SpendRepository } from '../data/spendRepository';
import type { ImportRepository, PreparedProposal } from '../data/importRepository';
import {
  chunkDocument, mergeExtracted, parseExtractReply, renderExtractPrompt,
  type Chunk, type ExtractTypes, type Extracted,
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
 * file is being read and what it has found so far.
 *
 * Every proposal reaches the stager with its evidence checked. The run is
 * staged with accept-all applied to the verified rows, so the review opens
 * with the trustworthy ones ready and the unverified ones waiting, greyed,
 * for a writer's own decision.
 */

export type ExtractEvent =
  | { kind: 'plan'; chunks: number; files: number; tokens: number }
  | { kind: 'chunk'; index: number; label: string; state: ChunkState; proposals: number; costUsd: number | null }
  | {
    kind: 'done';
    runId: string | null;
    proposals: number;
    unverified: number;
    dropped: { what: string; reason: string }[];
    /** Chunks that did not produce proposals, and why. */
    problems: { label: string; state: ChunkState; detail: string | null }[];
    costUsd: number;
  };

export type ChunkState = 'ok' | 'empty' | 'malformed' | 'refused' | 'failed' | 'blocked' | 'cancelled';

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
    const dropped: { what: string; reason: string }[] = [];
    const problems: Extract<ExtractEvent, { kind: 'done' }>['problems'] = [];
    let firstRunId: string | null = null;
    let cost = 0;
    let stopped = false;

    for (const [index, chunk] of chunks.entries()) {
      if (stopped || signal.aborted) {
        problems.push({ label: chunk.label, state: stopped ? 'blocked' : 'cancelled', detail: null });
        yield { kind: 'chunk', index, label: chunk.label, state: stopped ? 'blocked' : 'cancelled', proposals: 0, costUsd: null };
        continue;
      }
      try {
        await guardSpend(this.deps, projectId, null, PURPOSE);
      } catch (e) {
        if (!(e instanceof SpendCapError)) throw e;
        stopped = true;
        problems.push({ label: chunk.label, state: 'blocked', detail: e.message });
        yield { kind: 'chunk', index, label: chunk.label, state: 'blocked', proposals: 0, costUsd: null };
        continue;
      }

      const prompt = renderExtractPrompt(chunk, types);
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
      const maxTokens = Math.max(MIN_TOKENS, Math.ceil(chunk.text.length / 4 * OUTPUT_RATIO))
        + profile.reasoningAllowance;
      const runId = await this.deps.runs.start(projectId, {
        sceneId: null, purpose: PURPOSE, provider: account.kind, model: profile.modelId,
        params: {
          maxTokens, temperature: 0, path: chunk.path, label: chunk.label, dataPolicy: account.dataPolicy,
        },
        briefJson: JSON.stringify({ label: chunk.label, words: chunk.words }),
        promptRendered: prompt,
      });
      firstRunId ??= runId;

      const started = Date.now();
      let raw = '';
      let usage: { tokensIn: number; tokensOut: number; tokensReasoning: number } | null = null;
      let servedBy: string | null = null;
      let status: RunStatus = 'ok';
      let errorText: string | null = null;
      try {
        for await (const delta of adapter.chat({
          model: profile.modelId, messages, maxTokens, temperature: 0, dataPolicy: account.dataPolicy,
        }, signal)) {
          if (delta.kind === 'text') raw += delta.text;
          else if (delta.kind === 'usage') {
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
      }

      const reply = stripReasoningBlocks(raw);
      const parsed = status === 'ok' || status === 'truncated'
        ? parseExtractReply(reply, chunk, types)
        : { proposals: [], dropped: [], malformed: false };
      const chunkCost = costOf(profile, usage);
      cost += chunkCost ?? 0;
      await this.deps.runs.finish(runId, {
        outputText: reply || null,
        tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
        tokensReasoning: usage?.tokensReasoning ?? null,
        costUsd: chunkCost, latencyMs: Date.now() - started, status, servedBy, errorText,
      });
      if (usage && usage.tokensReasoning > 0) {
        await this.deps.providers.recordReasoning(profile.id, usage.tokensReasoning);
      }

      let state: ChunkState = 'ok';
      if (status === 'error') state = 'failed';
      else if (status === 'refused') state = 'refused';
      else if (status === 'cancelled') state = 'cancelled';
      else if (parsed.malformed) state = 'malformed';
      else if (parsed.proposals.length === 0) state = 'empty';
      if (state !== 'ok') {
        problems.push({
          label: chunk.label, state,
          detail: state === 'malformed' ? 'the model did not answer in the shape asked for' : errorText,
        });
      }
      gathered.push(...parsed.proposals);
      dropped.push(...parsed.dropped);
      yield { kind: 'chunk', index, label: chunk.label, state, proposals: parsed.proposals.length, costUsd: chunkCost };
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
      unverified: merged.filter((p) => !p.evidenceVerified).length, dropped, problems, costUsd: cost,
    };
  }
}
