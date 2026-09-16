import type { CredentialStore } from './credentials';
import { ProviderError, type ChatMessage, type ProviderAdapter } from './provider';
import { costOf, defaultAdapter, guardSpend, resolveRole, NoModelError, SpendCapError } from './roles';
import type { ProviderAccount, ProviderRepository } from '../data/providerRepository';
import type { RunsRepository } from '../data/runsRepository';
import type { SpendRepository } from '../data/spendRepository';
import type { ViolationsRepository } from '../data/violationsRepository';
import type { BriefLaw } from '../domain/lawsAndBans';
import {
  deterministicChecks, isRubric, parseRubricReply, renderRubricPrompt, type Finding, type Skipped,
} from '../domain/verify';
import { checkViolations, type BanList, type Violation } from '../text/repetition';
import { stripReasoningBlocks } from '../text/sanitise';

/**
 * The verification phase, run — [doc 04](../../docs/04-laws-engine.md) *Phase 2*,
 * the *Critique* step of [doc 06](../../docs/06-ai-pipeline.md).
 *
 * After a draft lands and before it is offered for acceptance:
 *
 * 1. **The free checks** run every time: regex and heuristic laws over the
 *    output, and the repetition guard against the ban list the brief carried.
 * 2. **The rubric laws** go to the `critique` role in one batched call —
 *    every rubric law, once — as their own `ai_run`, under the same spend cap
 *    as the draft. No critique model, no key, a cap, a cancelled draft, or a
 *    reply we cannot read: each is a named state the panel says in a sentence,
 *    never a silent skip, and never a fall-back to the draft model, which is
 *    the expensive one.
 * 3. **Every rubric quote is held against the prose.** A claim that cannot be
 *    located is stored and shown as *uncertain*, never counted as a finding.
 *
 * Findings are rows on the **draft** run, because their offsets are into its
 * output. Verification never blocks acceptance — it informs it. The writer
 * accepts, fixes, dismisses, or amends the law.
 */

export interface VerifyInput {
  projectId: string;
  sceneId: string | null;
  /** The draft run the findings belong to. */
  runId: string;
  /** The sanitised output. */
  text: string;
  laws: readonly BriefLaw[];
  ban: BanList;
  /** The writer stopped the draft: keep the free checks, spend nothing. */
  cancelled?: boolean;
}

export type RubricState =
  | 'ran' | 'no-laws' | 'no-model' | 'no-key' | 'blocked' | 'cancelled' | 'refused' | 'failed' | 'malformed';

export interface RubricReport {
  state: RubricState;
  /** How many rubric laws applied. */
  laws: number;
  /** A sentence for the panel when the state needs one. */
  detail: string | null;
  runId: string | null;
  costUsd: number | null;
}

export interface Verdict {
  /** Verified findings only, in text order. */
  findings: Finding[];
  /** Rubric claims whose quote is not in the prose. */
  uncertain: Finding[];
  repetition: Violation[];
  /** Laws with a check that could not run, and why. */
  skipped: Skipped[];
  rubric: RubricReport;
}

export interface VerifierDeps {
  runs: RunsRepository;
  providers: ProviderRepository;
  credentials: CredentialStore;
  violations: ViolationsRepository;
  spend: SpendRepository;
  adapterFor?: (account: ProviderAccount, apiKey: string) => ProviderAdapter;
}

const PURPOSE = 'critique';
/** Room for the answer: a few lines per law, never less than a short list. */
const TOKENS_PER_LAW = 120;
const MIN_TOKENS = 400;

export class Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(input: VerifyInput, signal: AbortSignal): Promise<Verdict> {
    const free = deterministicChecks(input.laws, input.text);
    const repetition = checkViolations(input.text, input.ban);
    const rubricLaws = input.laws.filter(isRubric);

    const rubric: RubricReport = {
      state: 'no-laws', laws: rubricLaws.length, detail: null, runId: null, costUsd: null,
    };
    let claims: Finding[] = [];
    if (rubricLaws.length > 0) {
      if (input.cancelled) {
        rubric.state = 'cancelled';
      } else {
        claims = await this.#rubric(input, rubricLaws, rubric, signal);
      }
    }

    const findings = [...free.findings, ...claims.filter((c) => c.evidenceVerified)]
      .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
    const uncertain = claims.filter((c) => !c.evidenceVerified);
    await this.deps.violations.record(input.runId, input.sceneId, [...findings, ...uncertain]);
    return { findings, uncertain, repetition, skipped: free.skipped, rubric };
  }

  /** The critique call. Fills in `report`; returns the parsed claims, verified or not. */
  async #rubric(
    input: VerifyInput, laws: readonly BriefLaw[], report: RubricReport, signal: AbortSignal,
  ): Promise<Finding[]> {
    let resolved;
    try {
      resolved = await resolveRole(this.deps.providers, input.projectId, 'critique');
    } catch (e) {
      if (e instanceof NoModelError) { report.state = 'no-model'; report.detail = e.message; return []; }
      throw e;
    }
    const { profile, account } = resolved;
    try {
      await guardSpend(this.deps, input.projectId, input.sceneId, PURPOSE);
    } catch (e) {
      if (e instanceof SpendCapError) { report.state = 'blocked'; report.detail = e.message; return []; }
      throw e;
    }
    const apiKey = account.credentialRef ? await this.deps.credentials.load(account.credentialRef) : null;
    if (!apiKey) {
      report.state = 'no-key';
      report.detail = `No key is saved for ${account.label} on this device.`;
      return [];
    }
    const adapter = (this.deps.adapterFor ?? defaultAdapter)(account, apiKey);

    const prompt = renderRubricPrompt(laws, input.text);
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const maxTokens = Math.max(MIN_TOKENS, TOKENS_PER_LAW * laws.length) + profile.reasoningAllowance;
    const runId = await this.deps.runs.start(input.projectId, {
      sceneId: input.sceneId, purpose: PURPOSE, provider: account.kind, model: profile.modelId,
      params: { maxTokens, temperature: 0, draftRunId: input.runId, dataPolicy: account.dataPolicy },
      briefJson: JSON.stringify({ laws: laws.map((l) => ({ id: l.id, title: l.title })) }),
      promptRendered: prompt,
    });
    report.runId = runId;

    const started = Date.now();
    let raw = '';
    let usage: { tokensIn: number; tokensOut: number; tokensReasoning: number } | null = null;
    let servedBy: string | null = null;
    let status: 'ok' | 'truncated' | 'cancelled' | 'refused' | 'error' = 'ok';
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
    const parsed = status === 'ok' || status === 'truncated' ? parseRubricReply(reply, laws, input.text)
      : { findings: [], malformed: false };
    const cost = costOf(profile, usage);
    await this.deps.runs.finish(runId, {
      outputText: reply || null,
      tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
      tokensReasoning: usage?.tokensReasoning ?? null,
      costUsd: cost, latencyMs: Date.now() - started, status, servedBy, errorText,
    });
    if (usage && usage.tokensReasoning > 0) {
      await this.deps.providers.recordReasoning(profile.id, usage.tokensReasoning);
    }

    report.costUsd = cost;
    if (status === 'error') { report.state = 'failed'; report.detail = errorText; return []; }
    if (status === 'refused') { report.state = 'refused'; report.detail = errorText ?? 'The provider declined.'; return []; }
    if (status === 'cancelled') { report.state = 'cancelled'; return []; }
    if (parsed.malformed) {
      report.state = 'malformed';
      report.detail = 'The critique model did not answer in the shape asked for, so its checks are unread.';
      return [];
    }
    report.state = 'ran';
    return parsed.findings;
  }
}
