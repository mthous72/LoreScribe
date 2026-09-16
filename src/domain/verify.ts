/**
 * The verification phase — [doc 04](../../docs/04-laws-engine.md) *Phase 2*.
 *
 * A law is a *checkable* constraint, and this is the checking. Three ways,
 * by `check_mode`:
 *
 * - **`regex`** — deterministic, free, instant. The pattern in `check_config`
 *   is run over the prose; every match is a finding with the span as evidence.
 * - **`heuristic`** — computed. A word band today (`minWords`/`maxWords`); the
 *   repetition guard is the other heuristic and runs from the ban list the
 *   brief already carries, outside this file.
 * - **`rubric`** (and `prompt+rubric`) — a cheap-model call that receives the
 *   prose and every rubric law at once and returns violations citing exact
 *   quotes. **Every quote is verified** ([doc 12 §3](../../docs/12-algorithms.md)):
 *   one that is not really in the prose downgrades the finding to *uncertain*,
 *   which is kept and shown as a claim the model could not support, and never
 *   reported as a finding.
 *
 * Everything here is pure. The model call and the rows are the verifier's.
 */

import { locateQuote } from './evidence';
import { countWords } from '../text/words';

export type CheckMode = 'prompt' | 'regex' | 'heuristic' | 'rubric' | 'prompt+rubric';
export type FindingSource = 'regex' | 'heuristic' | 'rubric';

/** What the checks need of a law. `BriefLaw` satisfies it. */
export interface CheckableLaw {
  id: string;
  title: string;
  severity: string;
  ruleText: string;
  checkMode: string;
  checkConfig: string | null;
}

export interface Finding {
  lawId: string;
  lawTitle: string;
  severity: string;
  source: FindingSource;
  /** The offending span as it stands in the prose; null for a whole-text finding. */
  quote: string | null;
  start: number | null;
  end: number | null;
  explanation: string;
  suggestedFix: string | null;
  /** False only for a rubric claim whose quote could not be found. */
  evidenceVerified: boolean;
}

export interface Skipped {
  lawId: string;
  reason: string;
}

export interface DeterministicResult {
  findings: Finding[];
  skipped: Skipped[];
}

/** Matches per regex law. More than this is one problem, not many. */
const MAX_MATCHES = 20;
const MAX_PATTERN = 200;

interface RegexConfig { pattern?: unknown; flags?: unknown; why?: unknown; fix?: unknown }
interface HeuristicConfig { kind?: unknown; minWords?: unknown; maxWords?: unknown }

function config<T>(law: CheckableLaw): T | null {
  if (!law.checkConfig) return null;
  try {
    const parsed = JSON.parse(law.checkConfig) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function isRubric(law: Pick<CheckableLaw, 'checkMode'>): boolean {
  return law.checkMode === 'rubric' || law.checkMode === 'prompt+rubric';
}

/** The free checks: regex and heuristic laws over the prose. */
export function deterministicChecks(laws: readonly CheckableLaw[], prose: string): DeterministicResult {
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  for (const law of laws) {
    if (law.checkMode === 'regex') {
      const c = config<RegexConfig>(law);
      const pattern = str(c?.pattern);
      if (!pattern) { skipped.push({ lawId: law.id, reason: 'no pattern' }); continue; }
      if (pattern.length > MAX_PATTERN) { skipped.push({ lawId: law.id, reason: 'pattern too long' }); continue; }
      let re: RegExp;
      try {
        // An explicit empty string means case-sensitive; only an absent one defaults.
        const flags = typeof c?.flags === 'string' ? c.flags : 'i';
        re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
      } catch (e) {
        skipped.push({ lawId: law.id, reason: `pattern does not compile: ${(e as Error).message}` });
        continue;
      }
      let n = 0;
      for (const m of prose.matchAll(re)) {
        if (!m[0]) continue; // an empty match says nothing about the prose
        findings.push({
          lawId: law.id, lawTitle: law.title, severity: law.severity, source: 'regex',
          quote: m[0], start: m.index, end: m.index + m[0].length,
          explanation: str(c?.why) ?? `Matches the pattern for “${law.title}”.`,
          suggestedFix: str(c?.fix), evidenceVerified: true,
        });
        if (++n >= MAX_MATCHES) break;
      }
    } else if (law.checkMode === 'heuristic') {
      const c = config<HeuristicConfig>(law);
      const kind = str(c?.kind) ?? 'wordBand';
      if (kind !== 'wordBand') {
        skipped.push({ lawId: law.id, reason: `unknown heuristic “${kind}”` });
        continue;
      }
      const min = num(c?.minWords);
      const max = num(c?.maxWords);
      if (min === null && max === null) { skipped.push({ lawId: law.id, reason: 'no word band' }); continue; }
      const { words } = countWords(prose);
      const whole = (explanation: string) => findings.push({
        lawId: law.id, lawTitle: law.title, severity: law.severity, source: 'heuristic',
        quote: null, start: null, end: null, explanation, suggestedFix: null, evidenceVerified: true,
      });
      if (min !== null && words < min) whole(`${words} words, under the ${min} the law asks for.`);
      else if (max !== null && words > max) whole(`${words} words, over the ${max} the law allows.`);
    }
  }
  return { findings, skipped };
}

/**
 * The critique turn. Numbered laws, the prose, and the shape of the answer:
 * a JSON array and nothing else, one item per violation, each quoting the
 * offending words exactly as they appear. Kept short for the same reason the
 * draft instruction is.
 */
export function renderRubricPrompt(laws: readonly CheckableLaw[], prose: string): string {
  const rules = laws.map((l, i) => {
    const extra = str(config<{ rubric?: unknown }>(l)?.rubric);
    return `${i + 1}. ${l.title}: ${l.ruleText.trim()}${extra ? ` (${extra})` : ''}`;
  });
  return [
    'You are checking a passage of fiction against numbered rules. Report only breaches you can point to.',
    '',
    'RULES',
    ...rules,
    '',
    'PASSAGE',
    prose.trim(),
    '',
    'Answer with a JSON array and no other text. Each item: {"law": <rule number>, '
    + '"quote": "<the offending words, copied exactly from the passage, at least twelve characters>", '
    + '"why": "<one sentence>", "fix": "<one sentence, or empty>"}. '
    + 'If nothing breaches a rule, answer [].',
  ].join('\n');
}

export interface RubricParse {
  /** Verified and uncertain together; read `evidenceVerified`. */
  findings: Finding[];
  /** The reply carried no JSON array we could read. */
  malformed: boolean;
}

interface RubricItem { law?: unknown; quote?: unknown; why?: unknown; fix?: unknown }

/** Read the model's reply, and hold every quote against the prose. */
export function parseRubricReply(reply: string, laws: readonly CheckableLaw[], prose: string): RubricParse {
  const open = reply.indexOf('[');
  const close = reply.lastIndexOf(']');
  if (open === -1 || close <= open) {
    return { findings: [], malformed: reply.trim() !== '' || laws.length > 0 };
  }
  let items: unknown;
  try {
    items = JSON.parse(reply.slice(open, close + 1));
  } catch {
    return { findings: [], malformed: true };
  }
  if (!Array.isArray(items)) return { findings: [], malformed: true };

  const findings: Finding[] = [];
  for (const raw of items as RubricItem[]) {
    if (!raw || typeof raw !== 'object') continue;
    const law = typeof raw.law === 'number' ? laws[raw.law - 1]
      : typeof raw.law === 'string' ? laws.find((l) => l.id === raw.law) ?? laws[Number(raw.law) - 1]
        : undefined;
    if (!law) continue;
    const claimed = str(raw.quote) ?? '';
    const hit = claimed ? locateQuote(prose, claimed) : null;
    findings.push({
      lawId: law.id, lawTitle: law.title, severity: law.severity, source: 'rubric',
      quote: hit ? hit.quote : claimed || null,
      start: hit?.start ?? null, end: hit?.end ?? null,
      explanation: str(raw.why) ?? `Breaches “${law.title}”.`,
      suggestedFix: str(raw.fix), evidenceVerified: hit !== null,
    });
  }
  return { findings, malformed: false };
}
