/**
 * Step 9 of the scene brief — the budget, and the text the model reads.
 *
 * [Doc 03 §9](../../docs/03-story-graph-and-context.md): *given the target
 * model's context window, allocate by the table; trimming is by priority within
 * each section — importance, spoiler weight, recency — never a blind
 * truncation. When the model is a small local one, the same algorithm simply
 * produces a tighter brief.*
 *
 * Everything before this step returns structure. This is the one place that
 * turns it into words, so the shape of every block is decided once, here, and
 * the inspector shows exactly what the model will see.
 *
 * **What is never trimmed** comes off the window first: the scene header, the
 * beats, the laws, the negative constraints, the ban list. If those alone do
 * not fit, `prefer` laws go, then `should`, and if that is still not enough the
 * brief is marked `overflow` and rendered anyway — a brief that says what it
 * could not do beats one that quietly did something else.
 *
 * **The reference band is reserved before the canon sections**, as doc 03
 * says, so imported material cannot be crowded out by a large cast. What it
 * does not use flows to the canon pool; what the canon sections do not use
 * flows, once, to the ones that are over.
 *
 * **Each section shrinks in its own way.** A dossier is not cut mid-sentence;
 * it drops a rung — voice notes, then description, then the entry — and the
 * least important entity drops first. Facts go in the reverse of step 3's
 * order, which was built for this. The ladder loses its oldest rung first and
 * re-cuts the tail with `proseTail` rather than truncating it, so the seam
 * still ends on the last words of the previous scene. Nothing here ever slices
 * a string.
 *
 * **Every constraint block is fenced and its bindingness restated after it**
 * ([doc 09 §14](../../docs/09-libriscribe-review.md)) — explicit open and close
 * delimiters, then a sentence saying the block binds. The shape is borrowed
 * from LibriScribe; the words are not, because the words are expression and
 * the shape is the idea ([D10, D11](../../docs/10-decisions.md)). Adherence to a
 * fenced and restated block measurably beats a bare list, and it costs a line.
 *
 * **Canon is one binding sentence over the FACTS block, not a restatement.**
 * Step 8 derived a canon law from every admitted canon fact and left the
 * rendering here, because the text of each is already in FACTS and paying for
 * it twice would defeat the budget the table is careful about. A fact that
 * FACTS could not fit is gone from the model's view, canon or not; it is named
 * in the section's `trimmed` list so the inspector can say so. That is the
 * honest cost of a small window, and it is the writer's to see.
 *
 * **The token counter is a placeholder behind an interface.** Nothing is known
 * about the target model here, so the estimate is the larger of two rough
 * ones — characters over four, words times four thirds — which errs long, and
 * erring long is the safe direction for a budget. A real counter drops in as
 * `options.count` without touching the allocator.
 */

import { countWords } from '../text/words';
import { renderBanList, isEmpty as noBans } from '../text/repetition';
import type { Dossiered, Dossier, BriefFact, NegativeFact } from './sceneBrief';
import { proseTail, type Ladder, type LadderRung } from './continuityLadder';
import type { Supplement, SupplementHit } from './semanticSupplement';
import type { Laws, BriefLaw, Severity } from './lawsAndBans';

export type TokenCounter = (text: string) => number;

export const estimateTokens: TokenCounter = (text) =>
  Math.max(Math.ceil(text.length / 4), Math.ceil((countWords(text).words * 4) / 3));

/** Doc 03 §9, as weights. Headroom is taken off the window before any of this. */
const SHARES = {
  reference: 0.08, cast: 0.25, facts: 0.18, continuity: 0.24, style: 0.08, related: 0.07,
} as const;
const HEADROOM = 0.10;
/** The tail is re-cut to this fraction of itself per step, and never below the floor. */
const TAIL_STEP = 0.75;
const TAIL_FLOOR = 60;

export type SectionKey =
  | 'scene' | 'beats' | 'laws' | 'negative' | 'reference' | 'cast' | 'canon'
  | 'facts' | 'related' | 'style' | 'bans' | 'continuity';

export interface BriefSection {
  key: SectionKey;
  title: string;
  text: string;
  tokens: number;
  /** Null for a section that is never trimmed. */
  allowed: number | null;
  /** What was cut, in the order it was cut. Empty when everything fitted. */
  trimmed: string[];
}

export interface CompiledBrief {
  text: string;
  sections: BriefSection[];
  window: number;
  outputReserve: number;
  used: number;
  /** The never-trimmed sections alone exceeded the window. */
  overflow: boolean;
}

export interface BudgetInput {
  dossiered: Dossiered;
  ladder: Ladder;
  supplement: Supplement;
  laws: Laws;
  /** Step 8b. */
  reference: readonly SupplementHit[];
  /** The writer's own prose, chosen by the caller. Never anybody else's. */
  exemplars: readonly string[];
  /** The target model's context window, in tokens. */
  window: number;
  options?: {
    /** Tokens kept back for the model's answer. Default 10% of the window. */
    outputReserve?: number;
    count?: TokenCounter;
  };
}

/* ------------------------------------------------------------- rendering */

const fence = (name: string, body: string, binding?: string): string =>
  [`=== ${name} ===`, body.trimEnd(), `=== END ${name} ===`, ...(binding ? [binding] : [])]
    .join('\n');

const line = (label: string, value: string | null | undefined): string | null =>
  value?.trim() ? `${label}: ${value.trim()}` : null;

function renderScene(d: Dossiered): string {
  const s = d.scene;
  const pov = s.povEntityName
    ? `${s.povEntityName}${[s.povMode, s.tense].filter(Boolean).length
      ? ` (${[s.povMode?.replace('_', ' '), s.tense].filter(Boolean).join(', ')})` : ''}`
    : null;
  const rows = [
    line('Title', s.title),
    line('Point of view', pov),
    line('Location', s.locationName),
    line('Purpose', s.purpose),
  ].filter((r): r is string => r !== null);
  return fence('SCENE', rows.join('\n') || 'Untitled scene.');
}

function renderBeats(d: Dossiered): string | null {
  if (d.beats.length === 0) return null;
  const rows = d.beats.map((b) => {
    const tag = [b.arcName, b.role, b.function].filter(Boolean).join(' · ');
    return `- ${b.title}${tag ? ` [${tag}]` : ''}${b.summary ? `\n  ${b.summary}` : ''}`;
  });
  return fence('BEATS', rows.join('\n'),
    'This scene must accomplish every beat above. Write toward them and nothing else.');
}

const SEVERITY_ORDER: Severity[] = ['must', 'should', 'prefer'];

function renderLaws(laws: readonly BriefLaw[]): string | null {
  if (laws.length === 0) return null;
  const groups = SEVERITY_ORDER
    .map((sev) => ({ sev, rows: laws.filter((l) => l.severity === sev) }))
    .filter((g) => g.rows.length > 0)
    .map((g) => `${g.sev.toUpperCase()}:\n${g.rows.map((l) => [
      `- [${l.title}] ${l.ruleText}`,
      ...(l.examplesGood ? [`  Good: ${l.examplesGood}`] : []),
      ...(l.examplesBad ? [`  Bad: ${l.examplesBad}`] : []),
    ].join('\n')).join('\n')}`);
  return fence('LAWS', groups.join('\n'),
    'The laws above bind every sentence you write. None of them bends.');
}

function renderNegative(negative: readonly NegativeFact[]): string | null {
  if (negative.length === 0) return null;
  return fence('DO NOT REVEAL', negative.map((n) => `- ${n.statement}`).join('\n'),
    'Do not reveal, hint at, or foreshadow any of the above. Silence is not enough; '
    + 'write as though none of it exists.');
}

function renderHits(name: string, hits: readonly SupplementHit[], note: string): string | null {
  if (hits.length === 0) return null;
  const rows = hits.map((h) => `- ${h.title ? `${h.title}: ` : ''}${h.text.trim()}`);
  return fence(name, `${note}\n${rows.join('\n')}`);
}

/** A dossier at a rung below the one step 5 gave it. */
type Rung = 'full' | 'standard' | 'name-only' | 'dropped';
/** Thinnest first, for choosing what to shrink next. */
const RUNG_ORDER: Record<Rung, number> = { 'name-only': 0, standard: 1, full: 2, dropped: 3 };
const RUNG_BELOW: Record<Rung, Rung> = {
  full: 'standard', standard: 'name-only', 'name-only': 'dropped', dropped: 'dropped',
};

function renderDossier(d: Dossier, rung: Rung): string | null {
  if (rung === 'dropped') return null;
  const role = d.via === 'location' ? 'setting' : d.role === 'pov' ? 'point of view' : d.role;
  const head = `## ${d.name} — ${d.typeKey}, ${role}`;
  const rows = [head];
  if (d.aliasUsed && d.aliasUsed !== d.name) rows.push(`Called here: ${d.aliasUsed}`);
  if (rung !== 'name-only' && d.aliases.length) rows.push(`Also called: ${d.aliases.join(', ')}`);
  if (d.summary?.trim()) rows.push(d.summary.trim());
  if (rung !== 'name-only' && d.description?.trim()) rows.push(d.description.trim());
  if (d.links.length) {
    rows.push(`Relationships: ${d.links.map((l) =>
      `${l.label ?? l.kind} ${l.otherName}${
        l.strength === null ? '' : ` (${l.strength > 0 ? '+' : ''}${l.strength})`}`,
    ).join('; ')}`);
  }
  if (rung === 'full' && d.voice.length) {
    rows.push('Voice:');
    for (const v of d.voice) rows.push(`- [${v.title}] ${v.ruleText} (${v.severity})`);
  }
  return rows.join('\n');
}

function renderCast(dossiers: readonly Dossier[], rungs: readonly Rung[]): string | null {
  const blocks = dossiers
    .map((d, i) => renderDossier(d, rungs[i] ?? d.depth))
    .filter((b): b is string => b !== null);
  if (blocks.length === 0) return null;
  return fence('CAST AND SETTING', blocks.join('\n\n'));
}

function factLine(f: BriefFact, povName: string | null): string {
  const tags: string[] = [];
  const who = povName ?? 'the point of view';
  if (f.status === 'pov-knows') {
    // A suspicion admitted on the POV's account is labelled as a suspicion, not
    // as knowledge — the difference between a character acting on a hunch and
    // narration stating a thing the reader has not been told.
    tags.push(f.povBelief === 'suspects'
      ? `${who} suspects this; the reader has not been told`
      : `known to ${who}, not yet to the reader`);
  } else if (f.povBelief && f.povBelief !== 'knows') {
    tags.push({
      suspects: `${who} suspects this`,
      believes_false: `${who} believes this is false`,
      denies: `${who} denies this`,
    }[f.povBelief]);
  }
  if (f.status === 'dramatic-irony') tags.push('the reader knows; the characters do not');
  if (f.certainty !== 'canon') tags.push(`${f.certainty} — not yet settled`);
  return `- ${f.statement.trim()}${tags.length ? ` (${tags.join('; ')})` : ''}`;
}

function renderFacts(d: Dossiered, facts: readonly BriefFact[]): string | null {
  if (facts.length === 0) return null;
  const name = new Map([...d.cast, ...d.setting].map((e) => [e.entityId, e.name]));
  const order = [...new Set(facts.map((f) => f.subjectEntityId))];
  const groups = order.map((id) =>
    `${name.get(id) ?? id}:\n${facts.filter((f) => f.subjectEntityId === id)
      .map((f) => factLine(f, d.scene.povEntityName)).join('\n')}`);
  return fence('FACTS', groups.join('\n'));
}

function renderCanon(laws: Laws): string | null {
  if (laws.canon.length === 0) return null;
  return fence('CANON',
    'Everything in FACTS is canon as of this scene. Do not contradict it, and do not '
    + 're-explain to the reader what the reader already knows.');
}

function renderStyle(exemplars: readonly string[]): string | null {
  if (exemplars.length === 0) return null;
  return fence('STYLE', `Match the voice of these passages, written by the author:\n\n${
    exemplars.map((e) => e.trim()).join('\n\n---\n\n')}`);
}

function renderBans(laws: Laws): string | null {
  if (noBans(laws.bans)) return null;
  return fence('BANS', renderBanList(laws.bans),
    'These bans are absolute. Check every sentence against them before you write it.');
}

interface LadderState {
  parts: LadderRung[];
  chapters: LadderRung[];
  scenes: LadderRung[];
  tailWords: number | null;
}

function renderContinuity(ladder: Ladder, st: LadderState): string | null {
  const blocks: string[] = [];
  const list = (title: string, rungs: LadderRung[]) => {
    if (rungs.length) {
      blocks.push(`${title}\n${rungs.map((r) =>
        `- ${r.title ? `${r.title}: ` : ''}${r.summary.trim()}`).join('\n')}`);
    }
  };
  list('Earlier acts:', st.parts);
  list('This act so far:', st.chapters);
  list('Recent scenes:', st.scenes);
  if (ladder.tail && st.tailWords !== null) {
    const text = st.tailWords >= ladder.tail.words
      ? ladder.tail.text
      : proseTail(ladder.tail.text, st.tailWords).text;
    blocks.push(`The previous scene ends (continue directly from here):\n\n${text.trim()}`);
  }
  if (blocks.length === 0) return null;
  return fence('STORY SO FAR', blocks.join('\n\n'));
}

/* --------------------------------------------------------------- fitting */

interface Fitted<T> { text: string | null; state: T; trimmed: string[] }

/**
 * More steps than any section could take: a dossier has three rungs, and the
 * ladder has one per rung plus a handful of re-cuts. A `shrink` that keeps
 * returning a state the same size as the last is a bug, and the loop must end
 * with the brief over budget and the fact recorded, not hang the app.
 */
const MAX_STEPS = 1000;

/**
 * Shrink a section a step at a time until it fits or nothing is left to cut.
 * Each section supplies its own `shrink`, which is where "by priority, never a
 * blind truncation" lives.
 */
function fit<T>(
  state: T,
  render: (s: T) => string | null,
  shrink: (s: T) => { next: T; note: string } | null,
  allowed: number,
  count: TokenCounter,
): Fitted<T> {
  const trimmed: string[] = [];
  let text = render(state);
  for (let steps = 0; text !== null && count(text) > allowed; steps++) {
    if (steps >= MAX_STEPS) {
      trimmed.push('gave up: shrinking made no progress');
      break;
    }
    const step = shrink(state);
    if (!step) break;
    state = step.next;
    trimmed.push(step.note);
    text = render(state);
  }
  return { text, state, trimmed };
}

const rungName = (r: LadderRung) => r.title ?? r.id;

export function compileBrief(input: BudgetInput): CompiledBrief {
  const count = input.options?.count ?? estimateTokens;
  const { dossiered: d, ladder, laws } = input;
  const outputReserve = input.options?.outputReserve ?? Math.round(input.window * HEADROOM);
  const budget = Math.max(0, input.window - outputReserve);

  // --- the never-trimmed sections, and the one exception when they do not fit
  let kept = laws.laws;
  const fixedTrimmed: string[] = [];
  const fixedText = () => ({
    scene: renderScene(d),
    beats: renderBeats(d),
    laws: renderLaws(kept),
    negative: renderNegative(d.negative),
    canon: renderCanon(laws),
    bans: renderBans(laws),
  });
  let fixed = fixedText();
  const fixedTokens = () => Object.values(fixed)
    .reduce((n, t) => n + (t ? count(t) : 0), 0);
  for (const sev of ['prefer', 'should'] as const) {
    if (fixedTokens() <= budget) break;
    const going = kept.filter((l) => l.severity === sev);
    if (going.length === 0) continue;
    kept = kept.filter((l) => l.severity !== sev);
    fixedTrimmed.push(`dropped ${going.length} ${sev} law${going.length === 1 ? '' : 's'} to fit`);
    fixed = fixedText();
  }
  const overflow = fixedTokens() > budget;
  const available = Math.max(0, budget - fixedTokens());

  // --- the reference band, reserved off the top
  const refAllowed = Math.min(Math.round(input.window * SHARES.reference), available);
  const ref = fit(
    [...input.reference],
    (hits) => renderHits('REFERENCE', hits,
      'Background from imported sources. Consult it; it is not canon and must not be reproduced.'),
    (hits) => (hits.length
      ? { next: hits.slice(0, -1), note: `dropped reference ${hits[hits.length - 1]!.ownerId}` }
      : null),
    refAllowed, count,
  );
  const refUsed = ref.text ? count(ref.text) : 0;
  const pool = Math.max(0, available - refUsed);

  // --- the canon sections: a share each, then one round of redistribution
  const canonKeys = ['cast', 'facts', 'continuity', 'style', 'related'] as const;
  const weightSum = canonKeys.reduce((n, k) => n + SHARES[k], 0);
  const share = (k: typeof canonKeys[number], of: number) => Math.floor((of * SHARES[k]) / weightSum);

  const natural = {
    cast: renderCast(d.dossiers, d.dossiers.map((x) => x.depth)),
    facts: renderFacts(d, d.facts),
    continuity: renderContinuity(ladder, {
      parts: ladder.parts, chapters: ladder.chapters, scenes: ladder.scenes,
      tailWords: ladder.tail ? ladder.tail.words : null,
    }),
    style: renderStyle(input.exemplars),
    related: renderHits('RELATED', input.supplement.hits,
      'Possibly relevant, found by search rather than linked by the author.'),
  };
  type CanonKey = typeof canonKeys[number];
  const need = Object.fromEntries(
    canonKeys.map((k) => [k, natural[k] ? count(natural[k]!) : 0])) as Record<CanonKey, number>;

  const allowed = Object.fromEntries(
    canonKeys.map((k) => [k, share(k, pool)])) as Record<CanonKey, number>;
  let surplus = 0;
  let overWeight = 0;
  for (const k of canonKeys) {
    if (need[k] <= allowed[k]) surplus += allowed[k] - need[k];
    else overWeight += SHARES[k];
  }
  if (surplus > 0 && overWeight > 0) {
    for (const k of canonKeys) {
      if (need[k] > allowed[k]) allowed[k] += Math.floor((surplus * SHARES[k]) / overWeight);
    }
  }

  const cast = fit(
    d.dossiers.map((x): Rung => x.depth),
    (rungs) => renderCast(d.dossiers, rungs),
    (rungs) => {
      // The thinnest entries go first — every name-only line before any
      // description, every description before any voice note — and among
      // equals the one furthest down the order. A brother who is not in the
      // room goes before the room does.
      let pick = -1;
      for (let i = rungs.length - 1; i >= 0; i--) {
        const r = rungs[i]!;
        if (r === 'dropped') continue;
        if (pick === -1 || RUNG_ORDER[r] < RUNG_ORDER[rungs[pick]!]) pick = i;
      }
      if (pick === -1) return null;
      const next = [...rungs];
      next[pick] = RUNG_BELOW[rungs[pick]!];
      return { next, note: `${d.dossiers[pick]!.name}: ${rungs[pick]} → ${next[pick]}` };
    },
    allowed.cast, count,
  );

  const facts = fit(
    [...d.facts],
    (fs) => renderFacts(d, fs),
    (fs) => fs.length
      ? { next: fs.slice(0, -1), note: `dropped fact: ${fs[fs.length - 1]!.statement}` }
      : null,
    allowed.facts, count,
  );

  const continuity = fit<LadderState>(
    {
      parts: [...ladder.parts], chapters: [...ladder.chapters], scenes: [...ladder.scenes],
      tailWords: ladder.tail ? ladder.tail.words : null,
    },
    (st) => renderContinuity(ladder, st),
    (st) => {
      // Oldest and coarsest first; the seam last, and re-cut rather than sliced.
      if (st.parts.length) {
        return { next: { ...st, parts: st.parts.slice(1) }, note: `dropped act: ${rungName(st.parts[0]!)}` };
      }
      if (st.chapters.length) {
        return {
          next: { ...st, chapters: st.chapters.slice(1) },
          note: `dropped chapter: ${rungName(st.chapters[0]!)}`,
        };
      }
      if (st.scenes.length) {
        return {
          next: { ...st, scenes: st.scenes.slice(1) },
          note: `dropped scene summary: ${rungName(st.scenes[0]!)}`,
        };
      }
      if (st.tailWords !== null && st.tailWords > TAIL_FLOOR) {
        const words = Math.max(TAIL_FLOOR, Math.floor(st.tailWords * TAIL_STEP));
        return { next: { ...st, tailWords: words }, note: `tail re-cut to ~${words} words` };
      }
      if (st.tailWords !== null) return { next: { ...st, tailWords: null }, note: 'dropped the tail' };
      return null;
    },
    allowed.continuity, count,
  );

  const style = fit(
    [...input.exemplars],
    renderStyle,
    (ex) => ex.length ? { next: ex.slice(0, -1), note: `dropped exemplar ${ex.length}` } : null,
    allowed.style, count,
  );

  const related = fit(
    [...input.supplement.hits],
    (hits) => renderHits('RELATED', hits,
      'Possibly relevant, found by search rather than linked by the author.'),
    (hits) => {
      const last = hits[hits.length - 1];
      return last ? { next: hits.slice(0, -1), note: `dropped ${last.ownerTable} ${last.ownerId}` } : null;
    },
    allowed.related, count,
  );

  // --- assemble, in the order the model reads it; the seam is the last thing
  const section = (
    key: SectionKey, title: string, text: string | null, allow: number | null, trimmed: string[] = [],
  ): BriefSection => ({
    key, title, text: text ?? '', tokens: text ? count(text) : 0, allowed: allow, trimmed,
  });

  const sections: BriefSection[] = [
    section('scene', 'Scene', fixed.scene, null),
    section('beats', 'Beats', fixed.beats, null),
    section('laws', 'Laws', fixed.laws, null, fixedTrimmed),
    section('negative', 'Do not reveal', fixed.negative, null),
    section('reference', 'Reference', ref.text, refAllowed, ref.trimmed),
    section('cast', 'Cast and setting', cast.text, allowed.cast, cast.trimmed),
    section('canon', 'Canon', fixed.canon, null),
    section('facts', 'Facts', facts.text, allowed.facts, facts.trimmed),
    section('related', 'Related', related.text, allowed.related, related.trimmed),
    section('style', 'Style', style.text, allowed.style, style.trimmed),
    section('bans', 'Bans', fixed.bans, null),
    section('continuity', 'Story so far', continuity.text, allowed.continuity, continuity.trimmed),
  ];

  const text = sections.filter((s) => s.text).map((s) => s.text).join('\n\n');
  return {
    text, sections, window: input.window, outputReserve,
    used: sections.reduce((n, s) => n + s.tokens, 0), overflow,
  };
}
