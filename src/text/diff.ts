/**
 * What changed between two drafts of a scene.
 *
 * Built on `matchingBlocks` — the difflib decomposition already in this
 * directory — rather than on a second algorithm, so there is one statement of
 * "what counts as the same text" in the codebase.
 *
 * Three decisions shape everything here, and each of them is about prose
 * specifically rather than about diffing in general:
 *
 * **Words, not lines.** A line diff is right for code, where a line is a unit a
 * person edits. Prose has no lines: a paragraph is one long line that reflows,
 * so changing a single word marks the whole paragraph changed and the writer
 * has to find the difference themselves — which is the one thing they came here
 * for. Characters are worse in the other direction: "walked" against "waited"
 * renders as a smear of single letters.
 *
 * **Paragraphs first, words second.** Running a word diff across a whole scene
 * finds matches between the "the" in the first line and the "the" in the last,
 * and shreds the result into confetti. So the scene is first diffed as a list
 * of paragraphs — which are long and near-unique, and therefore align cleanly —
 * and the word diff runs only inside a pair of paragraphs that survived as a
 * revision of each other. That also bounds the cost: the quadratic part never
 * sees more than one paragraph at a time.
 *
 * **A rewritten paragraph is shown as a rewrite.** Two paragraphs that share
 * almost nothing are not a revision of each other; pairing them anyway produces
 * a word diff where every word is struck through and every word is new, which
 * is longer and harder to read than simply showing both. `SIMILAR` is where
 * that line sits.
 */

import { matchingBlocks, sequenceRatio } from './similarity';

export type OpcodeKind = 'equal' | 'insert' | 'delete' | 'replace';

/** A difflib opcode: what happened to `a[aStart:aEnd]` to make `b[bStart:bEnd]`. */
export interface Opcode {
  kind: OpcodeKind;
  aStart: number; aEnd: number;
  bStart: number; bEnd: number;
}

/**
 * The edits turning `a` into `b`, covering both sequences completely.
 *
 * Adjacent equal runs are merged. Today that merge never fires: the matcher's
 * blocks are maximal and its recursion only ever descends strictly either side
 * of one, so two touching blocks cannot come back. It is here because
 * `similarity.ts` says in its own header that difflib's autojunk heuristic is
 * deliberately absent and to revisit if that changes — and autojunk is exactly
 * what makes blocks touch. Without the merge, turning it on would surface two
 * identical-looking stretches with an invisible seam between them.
 */
export function opcodes<T>(a: readonly T[], b: readonly T[]): Opcode[] {
  const out: Opcode[] = [];
  let i = 0;
  let j = 0;

  const push = (op: Opcode) => {
    const last = out[out.length - 1];
    if (op.kind === 'equal' && last?.kind === 'equal' && last.aEnd === op.aStart) {
      last.aEnd = op.aEnd;
      last.bEnd = op.bEnd;
      return;
    }
    out.push(op);
  };

  // A zero-length sentinel at the end, so the tail after the last match is
  // emitted by the same branch as every other gap rather than by a special case.
  const blocks = [...matchingBlocks(a, b), { aStart: a.length, bStart: b.length, size: 0 }];
  for (const m of blocks) {
    if (i < m.aStart || j < m.bStart) {
      const kind: OpcodeKind = i < m.aStart && j < m.bStart
        ? 'replace'
        : (i < m.aStart ? 'delete' : 'insert');
      push({ kind, aStart: i, aEnd: m.aStart, bStart: j, bEnd: m.bStart });
    }
    if (m.size > 0) {
      push({
        kind: 'equal',
        aStart: m.aStart, aEnd: m.aStart + m.size,
        bStart: m.bStart, bEnd: m.bStart + m.size,
      });
    }
    i = m.aStart + m.size;
    j = m.bStart + m.size;
  }
  return out;
}

/* ------------------------------------------------------------------- words */

export type RunKind = 'equal' | 'insert' | 'delete';

/** A stretch of text that survived, arrived or went. */
export interface Run {
  kind: RunKind;
  text: string;
}

/**
 * Split into words and the whitespace between them, losslessly.
 *
 * The gaps are tokens too, so joining the result gives back the original
 * character for character — which is what lets a run be rendered as the
 * writer's own text rather than as words with spaces guessed back in.
 */
export function tokenise(text: string): string[] {
  return text.match(/\s+|\S+/gu) ?? [];
}

/**
 * Above this many tokens on either side, the word diff is skipped.
 *
 * The matcher is quadratic in the worst case, and a writer who put a whole
 * scene in one paragraph should get a slightly coarser answer instantly rather
 * than a perfect one after the tab stops responding.
 */
const TOKEN_BUDGET = 4_000;

/** Word-level runs turning `a` into `b`. Deletions come before the insertions that replace them. */
export function diffWords(a: string, b: string): Run[] {
  const at = tokenise(a);
  const bt = tokenise(b);
  if (at.length > TOKEN_BUDGET || bt.length > TOKEN_BUDGET) {
    return [...(a ? [{ kind: 'delete' as const, text: a }] : []),
      ...(b ? [{ kind: 'insert' as const, text: b }] : [])];
  }

  const runs: Run[] = [];
  const add = (kind: RunKind, text: string) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last?.kind === kind) last.text += text;
    else runs.push({ kind, text });
  };

  for (const op of opcodes(at, bt)) {
    const before = at.slice(op.aStart, op.aEnd).join('');
    const after = bt.slice(op.bStart, op.bEnd).join('');
    if (op.kind === 'equal') add('equal', after);
    else {
      add('delete', before);
      add('insert', after);
    }
  }
  return runs;
}

/* -------------------------------------------------------------- paragraphs */

/**
 * Two paragraphs this alike are a revision of each other; less alike and they
 * are shown whole. Deliberately loose — a writer who rewrote a sentence in a
 * five-sentence paragraph still wants to see which sentence.
 */
const SIMILAR = 0.5;

export type ParagraphChange =
  | { kind: 'equal'; text: string }
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; text: string }
  /** Kept, but rewritten. `runs` is the word diff within it. */
  | { kind: 'changed'; before: string; after: string; runs: Run[] };

/**
 * Paragraphs, as a diff sees them.
 *
 * Blank lines are dropped rather than compared: they are identical to each
 * other everywhere, so keeping them would let the matcher align the blank line
 * in chapter one with the blank line in chapter three and call the prose
 * between them a single enormous edit.
 */
export function paragraphs(text: string): string[] {
  return text.split(/\r?\n/u).map((p) => p.trim()).filter((p) => p.length > 0);
}

const alike = (a: string, b: string) => sequenceRatio(tokenise(a), tokenise(b));

/** Diff two whole drafts. This is the function the UI renders. */
export function diffParagraphs(a: string, b: string): ParagraphChange[] {
  const ap = paragraphs(a);
  const bp = paragraphs(b);
  const out: ParagraphChange[] = [];

  for (const op of opcodes(ap, bp)) {
    if (op.kind === 'equal') {
      for (let i = op.aStart; i < op.aEnd; i++) out.push({ kind: 'equal', text: ap[i]! });
    } else if (op.kind === 'delete') {
      for (let i = op.aStart; i < op.aEnd; i++) out.push({ kind: 'delete', text: ap[i]! });
    } else if (op.kind === 'insert') {
      for (let j = op.bStart; j < op.bEnd; j++) out.push({ kind: 'insert', text: bp[j]! });
    } else {
      out.push(...align(ap.slice(op.aStart, op.aEnd), bp.slice(op.bStart, op.bEnd)));
    }
  }
  return out;
}

/**
 * Pair up the paragraphs inside one replaced stretch.
 *
 * Greedy and order-preserving, looking exactly one ahead. The lookahead is what
 * stops a single inserted paragraph from shifting every later pair by one and
 * reporting the whole stretch as rewritten — the common case of adding a
 * paragraph in the middle of a revised passage.
 */
function align(before: readonly string[], after: readonly string[]): ParagraphChange[] {
  const out: ParagraphChange[] = [];
  const changed = (a: string, b: string): ParagraphChange =>
    ({ kind: 'changed', before: a, after: b, runs: diffWords(a, b) });

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (alike(before[i]!, after[j]!) >= SIMILAR) {
      out.push(changed(before[i]!, after[j]!));
      i++; j++;
      continue;
    }
    // Not a pair. Is this paragraph's partner one further along on either side?
    const skipInsert = j + 1 < after.length ? alike(before[i]!, after[j + 1]!) : 0;
    const skipDelete = i + 1 < before.length ? alike(before[i + 1]!, after[j]!) : 0;
    if (skipInsert >= SIMILAR && skipInsert >= skipDelete) {
      out.push({ kind: 'insert', text: after[j]! });
      j++;
    } else if (skipDelete >= SIMILAR) {
      out.push({ kind: 'delete', text: before[i]! });
      i++;
    } else {
      // Neither: this paragraph was replaced outright by that one.
      out.push({ kind: 'delete', text: before[i]! });
      out.push({ kind: 'insert', text: after[j]! });
      i++; j++;
    }
  }
  for (; i < before.length; i++) out.push({ kind: 'delete', text: before[i]! });
  for (; j < after.length; j++) out.push({ kind: 'insert', text: after[j]! });
  return out;
}

/* ------------------------------------------------------------------- shape */

export interface DiffStats {
  /** Words present in the new draft and not the old. */
  added: number;
  /** Words present in the old draft and not the new. */
  removed: number;
  /** Paragraphs untouched. */
  unchanged: number;
}

const words = (text: string) => (text.match(/\S+/gu) ?? []).length;

export function diffStats(changes: readonly ParagraphChange[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const change of changes) {
    if (change.kind === 'equal') { unchanged++; continue; }
    if (change.kind === 'insert') { added += words(change.text); continue; }
    if (change.kind === 'delete') { removed += words(change.text); continue; }
    for (const run of change.runs) {
      if (run.kind === 'insert') added += words(run.text);
      if (run.kind === 'delete') removed += words(run.text);
    }
  }
  return { added, removed, unchanged };
}

/** An elided run of untouched paragraphs, so a scene-length diff stays readable. */
export interface Gap { kind: 'gap'; paragraphs: number }
export type DiffLine = ParagraphChange | Gap;

/**
 * Collapse long stretches of untouched prose, keeping `context` paragraphs
 * either side of each change.
 *
 * Without this a one-word fix in a three-thousand-word scene renders three
 * thousand words, and the change is somewhere in the middle of them.
 */
export function collapse(changes: readonly ParagraphChange[], context = 1): DiffLine[] {
  const keep = new Set<number>();
  changes.forEach((change, i) => {
    if (change.kind === 'equal') return;
    for (let k = i - context; k <= i + context; k++) keep.add(k);
  });

  const out: DiffLine[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden > 0) out.push({ kind: 'gap', paragraphs: hidden });
    hidden = 0;
  };
  changes.forEach((change, i) => {
    if (keep.has(i)) { flush(); out.push(change); }
    else hidden++;
  });
  flush();
  return out;
}
