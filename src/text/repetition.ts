/**
 * Repetition guard — docs/12 §1.
 *
 * Models, small local ones especially, reuse distinctive imagery and open
 * consecutive scenes the same way. "Vary your imagery" does not fix it;
 * explicitly naming the banned phrases does. So this builds a ban list from the
 * prose already written, renders it as hard constraints, and checks the result
 * deterministically afterwards — the check is not a second model call.
 */

import { sequenceRatio } from './similarity';

/**
 * Function words, contractions and generic pronouns.
 *
 * Content is not sensitive to the exact membership — a phrase qualifies on how
 * many NON-stopwords it carries, so a missing entry costs at most one marginal
 * candidate. Present to stop "out of the" and "he said that" dominating.
 */
export const STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each',
  'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here',
  'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'itself', 'just', 'me', 'more', 'most', 'much', 'must', 'my', 'myself', 'no', 'nor',
  'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours',
  'ourselves', 'out', 'over', 'own', 'same', 'shall', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // Contractions, after apostrophe-preserving tokenisation.
  "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd", "he's", "he'd",
  "he'll", "she's", "she'd", "she'll", "it's", "we're", "we've", "we'll", "they're",
  "they've", "they'll", "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't",
  "didn't", "can't", "couldn't", "won't", "wouldn't", "shouldn't", "hasn't", "haven't",
  "hadn't", "that's", "there's", "what's", "let's",
]);

const MIN_N = 3;
const MAX_N = 5;
const MAX_PHRASES = 12;
const MAX_WORDS = 10;
const RECENT_OPENINGS = 6;
const OPENING_SIMILARITY_FLAG = 0.6;

/** Headings and scene markers are scaffolding and must never enter the analysis. */
const SCAFFOLD_LINE = /^\s*(?:#{1,6}\s|\*{0,2}\s*(?:scene|chapter)\s+\d+\b)/i;

const WORD_RE = /[\p{L}][\p{L}']*/gu;

export interface Tokenised {
  /** Word tokens, per sentence, lowercased. N-grams never cross these. */
  sentences: string[][];
  /** Lowercased words seen capitalised mid-sentence. Never bannable. */
  properNouns: Set<string>;
  totalWords: number;
}

export function tokenise(text: string): Tokenised {
  const body = text
    .split('\n')
    .filter((l) => !SCAFFOLD_LINE.test(l))
    .join('\n');

  const sentences: string[][] = [];
  const properNouns = new Set<string>();
  let totalWords = 0;

  for (const paragraph of body.split(/\n\s*\n/)) {
    for (const raw of paragraph.split(/(?<=[.!?])\s+/)) {
      const matches = [...raw.matchAll(WORD_RE)].map((m) => m[0]);
      if (!matches.length) continue;
      matches.forEach((w, i) => {
        // Capitalised mid-sentence: a name or a place, and it recurs
        // legitimately. Banning these would forbid the protagonist.
        if (i > 0 && /^\p{Lu}/u.test(w)) properNouns.add(w.toLowerCase());
      });
      const lower = matches.map((w) => w.toLowerCase());
      sentences.push(lower);
      totalWords += lower.length;
    }
  }

  return { sentences, properNouns, totalWords };
}

export interface BanList {
  phrases: string[];
  words: string[];
  openings: string[];
}

function isContentWord(w: string, properNouns: Set<string>): boolean {
  return !STOPWORDS.has(w) && !properNouns.has(w);
}

/** Words shared between the tail of `a` and the head of `b`, at least `min`. */
function overlapLength(a: string[], b: string[], min: number): number {
  const max = Math.min(a.length, b.length) - 1;
  for (let k = max; k >= min; k--) {
    if (a.slice(a.length - k).join(' ') === b.slice(0, k).join(' ')) return k;
  }
  return 0;
}

/**
 * Chain-merge overlapping fragments.
 *
 * A repeated phrase longer than the 5-gram window surfaces as several
 * overlapping fragments — `a heavy sheet of` / `heavy sheet of corrugated` /
 * `sheet of corrugated plastic`. Without merging, the ban list is
 * three-quarters duplicates and burns the budget it is supposed to protect.
 */
function mergeStaggered(phrases: string[][]): string[][] {
  const out = phrases.map((p) => [...p]);
  for (;;) {
    let merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const k = overlapLength(out[i]!, out[j]!, 2);
        if (k > 0) {
          out[i] = [...out[i]!, ...out[j]!.slice(k)];
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    if (!merged) break;
  }

  // Then drop anything contained in a longer phrase.
  const asText = out.map((p) => p.join(' '));
  return out.filter((_, i) =>
    !asText.some((other, j) => j !== i && other.length > asText[i]!.length && other.includes(asText[i]!)));
}

export interface BanListOptions {
  /** First sentences of recent scenes, most recent last. */
  recentOpenings?: string[];
}

export function buildBanList(prose: string, options: BanListOptions = {}): BanList {
  const { sentences, properNouns, totalWords } = tokenise(prose);

  // --- phrases
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    for (let n = MIN_N; n <= MAX_N; n++) {
      for (let i = 0; i + n <= sentence.length; i++) {
        const gram = sentence.slice(i, i + n).join(' ');
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }

  const candidates: { phrase: string; count: number }[] = [];
  for (const [phrase, count] of counts) {
    const words = phrase.split(' ');
    if (words.some((w) => properNouns.has(w))) continue; // never bannable
    const content = words.filter((w) => isContentWord(w, properNouns)).length;
    const qualifies = (count >= 2 && content >= 2) || (count >= 3 && content >= 1);
    if (qualifies) candidates.push({ phrase, count });
  }

  // Most frequent first; among equals prefer the fuller wording.
  candidates.sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);

  const kept: string[] = [];
  for (const { phrase } of candidates) {
    if (kept.some((k) => k.includes(phrase) || phrase.includes(k))) continue;
    kept.push(phrase);
  }

  const phrases = mergeStaggered(kept.map((k) => k.split(' ')))
    .map((p) => p.join(' '))
    .slice(0, MAX_PHRASES);

  // --- single words, invisible to the phrase detector
  const wordCounts = new Map<string, number>();
  for (const sentence of sentences) {
    for (const w of sentence) {
      if (w.length <= 3) continue;
      if (!isContentWord(w, properNouns)) continue;
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }
  const threshold = Math.max(6, Math.floor((totalWords / 1000) * 2.5));
  const words = [...wordCounts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_WORDS)
    .map(([w]) => w);

  const openings = (options.recentOpenings ?? []).slice(-RECENT_OPENINGS);

  return { phrases, words, openings };
}

/** Nothing qualified — say so, rather than emitting empty headings. */
export function isEmpty(ban: BanList): boolean {
  return ban.phrases.length === 0 && ban.words.length === 0 && ban.openings.length === 0;
}

/**
 * Render as hard constraints rather than preferences. A model told a phrase is
 * "discouraged" will use it; told it is forbidden, it mostly will not.
 */
export function renderBanList(ban: BanList): string {
  if (isEmpty(ban)) return '';
  const blocks: string[] = [];

  if (ban.phrases.length) {
    blocks.push(
      'FORBIDDEN PHRASES — do not use any of these, or a close variant of them:\n'
      + ban.phrases.map((p) => `- "${p}"`).join('\n'),
    );
  }
  if (ban.words.length) {
    blocks.push(
      'OVERUSED WORDS — each may appear at most once; prefer a different word:\n'
      + ban.words.map((w) => `- ${w}`).join('\n'),
    );
  }
  if (ban.openings.length) {
    blocks.push(
      'RECENT SCENE OPENINGS — begin from a different image, sense and sentence '
      + 'structure than every one of these:\n'
      + ban.openings.map((o) => `- ${o}`).join('\n'),
    );
  }
  return blocks.join('\n\n');
}

export type ViolationKind = 'phrase' | 'word' | 'opening';

export interface Violation {
  kind: ViolationKind;
  value: string;
  /** Occurrences, or the similarity ratio for an opening. */
  detail: number;
}

function wordSequence(text: string): string[] {
  return tokenise(text).sentences.flat();
}

/**
 * Deterministic post-generation check. No model, no judgement call.
 *
 * Violations are named explicitly and fed into EXACTLY ONE regeneration
 * attempt. A second failure says something about the model or the scene, and is
 * not worth more tokens.
 */
export function checkViolations(scene: string, ban: BanList): Violation[] {
  const found: Violation[] = [];
  const seq = ` ${wordSequence(scene).join(' ')} `;

  for (const phrase of ban.phrases) {
    const needle = ` ${phrase} `;
    let n = 0;
    let at = seq.indexOf(needle);
    while (at !== -1) { n++; at = seq.indexOf(needle, at + 1); }
    if (n > 0) found.push({ kind: 'phrase', value: phrase, detail: n });
  }

  for (const word of ban.words) {
    const n = seq.split(` ${word} `).length - 1;
    if (n > 1) found.push({ kind: 'word', value: word, detail: n }); // one is allowed
  }

  const first = tokenise(scene).sentences[0];
  if (first && ban.openings.length) {
    for (const opening of ban.openings) {
      const ratio = sequenceRatio(first, wordSequence(opening));
      if (ratio >= OPENING_SIMILARITY_FLAG) {
        found.push({ kind: 'opening', value: opening, detail: Number(ratio.toFixed(3)) });
      }
    }
  }

  return found;
}

export interface OveruseRow {
  phrase: string;
  occurrences: number;
}

/**
 * Revision mode — the same detector as a report over existing prose.
 * The advice is always the same: leave one instance, reword the rest.
 */
export function overuseReport(prose: string): OveruseRow[] {
  const ban = buildBanList(prose);
  const seq = ` ${wordSequence(prose).join(' ')} `;
  const count = (s: string) => {
    let n = 0;
    let at = seq.indexOf(` ${s} `);
    while (at !== -1) { n++; at = seq.indexOf(` ${s} `, at + 1); }
    return n;
  };
  return [...ban.phrases, ...ban.words]
    .map((phrase) => ({ phrase, occurrences: count(phrase) }))
    .sort((a, b) => b.occurrences - a.occurrences || a.phrase.localeCompare(b.phrase));
}
