/**
 * Word counting — docs/12 §6.
 *
 * One implementation, used by goals, statistics and context-budget estimates
 * alike. If they disagree, every number the app reports becomes suspect, and a
 * writer who catches the tool miscounting once stops believing the rest of it.
 *
 * Deliberately not `text.split(' ').length`.
 */

export interface Counts {
  words: number;
  characters: number;
  /** Characters excluding whitespace — the figure some venues ask for. */
  charactersNoSpaces: number;
  paragraphs: number;
  sentences: number;
}

/**
 * Lines the writer does not consider prose.
 *
 * `%` opens a comment line and `@` a keyword line. This is LoreScribe's own
 * convention, declared here so the counter and the exporter cannot disagree
 * about it later.
 */
const META_LINE = /^\s*[%@]/;
const BLOCKQUOTE = /^\s*>+\s?/;
const ATX_HEADING = /^\s*#{1,6}\s+/;

/** Inline markup that should not contribute characters. */
function stripInlineMarkup(line: string): string {
  return line
    // Links and images: keep the visible text, drop the target.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Inline code, bold, italic, strikethrough, highlight.
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*{1,3}|_{1,3}|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2')
    // Any emphasis runs left unpaired.
    .replace(/[*_~=]{1,3}/g, '');
}

/**
 * Word separators.
 *
 * En and em dashes split words: `word—word` is two words, and the naive split
 * counts one. Hyphens do NOT split — `well-lit` is one word, which is what a
 * writer expects and what other tools report.
 */
const SEPARATORS = /[\s‒–—―⸺⸻—–]+/;
const WORDLIKE = /[\p{L}\p{N}]/u;

export function countWords(text: string): Counts {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];

  for (const raw of rawLines) {
    if (META_LINE.test(raw)) continue;
    let line = raw.replace(BLOCKQUOTE, '').replace(ATX_HEADING, '');
    line = stripInlineMarkup(line);
    kept.push(line);
  }

  const cleaned = kept.join('\n');

  const words = cleaned
    .split(SEPARATORS)
    .filter((t) => WORDLIKE.test(t)).length;

  // A paragraph is a run of non-blank lines. Meta lines are already gone, so a
  // comment between two paragraphs does not silently fuse them.
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0).length;

  const sentences = countSentences(cleaned);

  const characters = cleaned.replace(/\n/g, '').length;
  const charactersNoSpaces = cleaned.replace(/\s/g, '').length;

  return { words, characters, charactersNoSpaces, paragraphs, sentences };
}

/**
 * Sentence count, shared with the readability statistics so the two cannot
 * drift. A terminator run (`?!`, `...`) ends one sentence, not three.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const n = (trimmed.match(/[.!?]+(?=["'”’)\]]*(\s|$))/g) ?? []).length;
  // Trailing prose with no terminator is still a sentence.
  return n === 0 ? 1 : n + (/[^.!?"'”’)\]\s]\s*$/.test(trimmed) ? 1 : 0);
}

/** Split into sentences, for anything that needs the text rather than the count. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["'”’)\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
