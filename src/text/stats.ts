/**
 * Readability and pacing statistics — docs/12 §7.
 *
 * All offline, no dependencies, no model. Presented as diagnosis, never as a
 * score: doc 07 §E rules out grading prose 1–10, because a grade is
 * demoralising and tells the writer nothing they can act on.
 */

import { countWords, splitSentences } from './words';

const WORDS_PER_MINUTE = 220;

/**
 * English syllable heuristic.
 *
 * Wrong on plenty of individual words — "queue" and "business" among them — and
 * that is tolerable, because it is only ever aggregated over thousands of words
 * into a readability index that is itself approximate. It must not be used to
 * make a claim about any single word.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;

  // Trailing silent 'e', 'es', 'ed' — but not after 'l', where the vowel is
  // sounded: "table", "candles", "handled".
  let s = w;
  const notAfterL = (base: string) => base.length > 0 && !base.endsWith('l');
  if (s.endsWith('es') || s.endsWith('ed')) {
    const base = s.slice(0, -2);
    if (notAfterL(base)) s = base;
  } else if (s.endsWith('e')) {
    const base = s.slice(0, -1);
    if (notAfterL(base)) s = base;
  }

  s = s.replace(/^y/, '');
  const groups = s.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 0);
}

function wordsOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
}

export interface ProseStats {
  words: number;
  sentences: number;
  paragraphs: number;
  syllables: number;
  /** Higher is easier. Roughly 60–70 is plain English. */
  fleschReadingEase: number | null;
  /** US school grade level. */
  fleschKincaidGrade: number | null;
  averageSentenceLength: number | null;
  /** Share of characters inside paired double quotes, 0–1. */
  dialogueRatio: number;
  /** Share of words ending in -ly, 0–1. Crude, and useful anyway. */
  adverbRatio: number;
  readingMinutes: number;
}

/**
 * Share of the text inside dialogue.
 *
 * Quote state is tracked across the whole text rather than regex-matching
 * pairs, so an unbalanced quote — a paragraph of continuing speech that opens
 * without closing, which is correct English typography — degrades to "the last
 * run doesn't count" instead of swallowing the rest of the chapter.
 */
export function dialogueRatio(text: string): number {
  if (!text) return 0;
  const normalised = text.replace(/[“”„‟]/g, '"');
  let inside = false;
  let run = 0;
  let counted = 0;
  for (const ch of normalised) {
    if (ch === '"') {
      if (inside) { counted += run; run = 0; }
      inside = !inside;
      continue;
    }
    if (inside) run += 1;
  }
  // `run` is deliberately discarded: it belongs to a quote that never closed.
  return counted / normalised.length;
}

export function proseStats(text: string): ProseStats {
  const counts = countWords(text);
  const sentences = splitSentences(text);
  const words = wordsOf(text);
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);

  const nWords = counts.words;
  const nSentences = counts.sentences;
  const canScore = nWords > 0 && nSentences > 0;

  const wordsPerSentence = canScore ? nWords / nSentences : null;
  const syllablesPerWord = nWords > 0 ? syllables / nWords : null;

  const fleschReadingEase = canScore && syllablesPerWord !== null
    ? 206.835 - 1.015 * (wordsPerSentence as number) - 84.6 * syllablesPerWord
    : null;
  const fleschKincaidGrade = canScore && syllablesPerWord !== null
    ? 0.39 * (wordsPerSentence as number) + 11.8 * syllablesPerWord - 15.59
    : null;

  const adverbs = words.filter((w) => /ly$/i.test(w)).length;

  return {
    words: nWords,
    sentences: nSentences,
    paragraphs: counts.paragraphs,
    syllables,
    fleschReadingEase,
    fleschKincaidGrade,
    averageSentenceLength: wordsPerSentence,
    dialogueRatio: dialogueRatio(text),
    adverbRatio: nWords > 0 ? adverbs / nWords : 0,
    readingMinutes: nWords / WORDS_PER_MINUTE,
  };
}

/** Aggregate across scenes, for the chapter and book views. */
export function aggregateStats(parts: ProseStats[]): ProseStats {
  const sum = (f: (p: ProseStats) => number) => parts.reduce((n, p) => n + f(p), 0);
  const words = sum((p) => p.words);
  const sentences = sum((p) => p.sentences);
  const syllables = sum((p) => p.syllables);
  const wordsPerSentence = sentences > 0 ? words / sentences : null;
  const syllablesPerWord = words > 0 ? syllables / words : null;
  const canScore = wordsPerSentence !== null && syllablesPerWord !== null;

  return {
    words,
    sentences,
    paragraphs: sum((p) => p.paragraphs),
    syllables,
    // Recomputed from the totals, not averaged from the parts: a mean of ratios
    // over unequal scenes is not the ratio of the whole.
    fleschReadingEase: canScore ? 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord : null,
    fleschKincaidGrade: canScore ? 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59 : null,
    averageSentenceLength: wordsPerSentence,
    dialogueRatio: words > 0 ? sum((p) => p.dialogueRatio * p.words) / words : 0,
    adverbRatio: words > 0 ? sum((p) => p.adverbRatio * p.words) / words : 0,
    readingMinutes: words / WORDS_PER_MINUTE,
  };
}
