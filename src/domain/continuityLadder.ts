/**
 * Step 6 of the scene brief — the continuity ladder.
 *
 * [Doc 03](../../docs/03-story-graph-and-context.md): *hierarchical
 * compression, not a flat window: the previous scene's final ~300 words
 * verbatim (so prose voice carries across the seam), then summaries of the
 * previous 2–5 scenes, then chapter summaries for the current act, then a
 * one-paragraph book-so-far. Cost grows logarithmically with novel length
 * instead of linearly.*
 *
 * The rungs map onto columns the schema already names for the purpose —
 * `scene.summary` is *rolling compression level 1*, `chapter.summary` is
 * *level 2* — so this reads them rather than inventing a compression scheme.
 *
 * It lives apart from the compiler's other steps, and takes no working set.
 * Steps 1 to 5 each refine the same set of entities and have to run in order;
 * the ladder is about the manuscript, not about who is in it, and needs exactly
 * two things: where we are, and which chapter we are in.
 *
 * **Ranks do the filtering, and that is the whole temporal discipline here.**
 * A rung may only contain material that comes before this scene. Chapter and
 * part ranks are the same `globalRank` composition with the lower segments left
 * off, which makes them literal prefixes of the scene ranks beneath them — so a
 * chapter sorts below its own first scene and above every scene of the chapter
 * before it, and one lexicographic comparison answers the question at every
 * level.
 *
 * **`book.synopsis` is not the book so far, and is never read here.** It is the
 * pitch for the finished book: it knows how the story ends. Dropping it into a
 * brief compiled for chapter five would hand the model the ending in the one
 * section whose entire purpose is to say what has happened *up to now*. The
 * top rung is built from the summaries of earlier *parts* instead, which
 * describe blocks of the book that are genuinely behind us. Doc 03 asks for one
 * paragraph and this gives one per completed act, which is the closest thing
 * the schema holds that cannot leak forwards.
 */

import { countWords } from '../text/words';

export interface LadderScene {
  id: string;
  globalRank: string;
  chapterId: string;
  title: string | null;
  /** `scene.summary` — rolling compression level 1. */
  summary: string | null;
  /** `scene.content_text`. Null or empty for a scene that is only planned. */
  text: string | null;
}

export interface LadderChapter {
  id: string;
  partId: string | null;
  /** `globalRank([bookKey, partKey, chapterKey])` — comparable to scene ranks. */
  rank: string;
  number: number | null;
  title: string | null;
  /** `chapter.summary` — rolling compression level 2. */
  summary: string | null;
}

export interface LadderPart {
  id: string;
  /** `globalRank([bookKey, partKey])`. */
  rank: string;
  title: string | null;
  summary: string | null;
}

export interface LadderOptions {
  /** Words of verbatim tail. Doc 03 says ~300. */
  tailWords?: number;
  /** Scene summaries below the tail. Doc 03 says 2–5. */
  sceneSummaries?: number;
}

export interface LadderInput {
  /** The scene being compiled for. */
  atRank: string;
  /** Its `chapter_id`. */
  chapterId: string;
  /** Scenes of the book. Anything at or after `atRank` is ignored. */
  scenes: readonly LadderScene[];
  chapters: readonly LadderChapter[];
  parts: readonly LadderPart[];
  options?: LadderOptions;
}

export interface LadderTail {
  sceneId: string;
  title: string | null;
  /** Verbatim, ending exactly where the previous scene ends. */
  text: string;
  /** Counted by the app's one word counter, not by the cut. */
  words: number;
  /** True when the scene was longer than the budget and the start was cut. */
  truncated: boolean;
}

export interface LadderRung {
  id: string;
  title: string | null;
  summary: string;
}

/**
 * A rung that should have had something and did not.
 *
 * Named rather than silently empty, for the same reason step 1 names an
 * unresolved entity: a brief missing the last three scene summaries looks
 * exactly like a book that has only just started. This is also the list the
 * gap-fill screen exists to work through.
 */
export interface LadderGap {
  rung: 'tail' | 'scene' | 'chapter' | 'part';
  id: string;
  title: string | null;
}

export interface Ladder {
  /** The seam: the previous scene's last words. */
  tail: LadderTail | null;
  /** Scenes below the tail, oldest first. */
  scenes: LadderRung[];
  /** Chapters of this act that are already behind us, oldest first. */
  chapters: LadderRung[];
  /** Completed acts, oldest first. The book so far. */
  parts: LadderRung[];
  missing: LadderGap[];
}

const DEFAULTS = { tailWords: 300, sceneSummaries: 4 } as const;

const byRank = <T extends { globalRank?: string; rank?: string }>(a: T, b: T) => {
  const x = a.globalRank ?? a.rank ?? '';
  const y = b.globalRank ?? b.rank ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
};

const said = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * The last words of a scene, cut at a paragraph where one is close enough.
 *
 * The *end* has to be exact — this is the text the next scene continues from —
 * so the cut is always at the start. Prose comes in paragraphs and a paragraph
 * boundary reads as intentional, so whole paragraphs are taken from the end
 * until one more would overshoot. A single closing paragraph longer than the
 * whole budget is the one case that cannot be honoured that way, and there the
 * cut falls on a whitespace boundary: mid-sentence is survivable and tells the
 * model where it is, mid-word is not.
 *
 * The slice is by whitespace runs while the reported count comes from
 * `countWords`, which knows that an em dash separates words and a hyphen does
 * not. The two can differ by a word or two; the alternative is re-joining
 * tokens, which would not give back the writer's text character for character.
 */
export function proseTail(text: string, targetWords: number): { text: string; truncated: boolean } {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { text: '', truncated: false };

  const taken: string[] = [];
  let words = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]!;
    const n = countWords(p).words;
    if (taken.length > 0 && words + n > targetWords) break;
    taken.unshift(p);
    words += n;
  }

  const whole = taken.join('\n\n');
  const truncated = taken.length < paragraphs.length;
  if (words <= targetWords) return { text: whole, truncated };

  // One paragraph, longer than the budget on its own.
  const starts = [...whole.matchAll(/\S+/g)].map((m) => m.index);
  if (starts.length <= targetWords) return { text: whole, truncated };
  return { text: whole.slice(starts[starts.length - targetWords]!), truncated: true };
}

export function continuityLadder(input: LadderInput): Ladder {
  const tailWords = input.options?.tailWords ?? DEFAULTS.tailWords;
  const wanted = input.options?.sceneSummaries ?? DEFAULTS.sceneSummaries;
  const missing: LadderGap[] = [];

  const before = input.scenes
    .filter((s) => s.globalRank < input.atRank)
    .sort(byRank);

  // The seam. A scene that was planned and never written has no voice to carry
  // across it, so it drops to the rung below rather than producing an empty
  // block that reads as silence.
  const previous = before[before.length - 1];
  let tail: LadderTail | null = null;
  if (previous) {
    const prose = said(previous.text);
    if (prose) {
      const cut = proseTail(prose, tailWords);
      tail = {
        sceneId: previous.id, title: previous.title,
        text: cut.text, words: countWords(cut.text).words, truncated: cut.truncated,
      };
    } else {
      missing.push({ rung: 'tail', id: previous.id, title: previous.title });
    }
  }

  const rest = tail ? before.slice(0, -1) : before;
  const scenes: LadderRung[] = [];
  for (const s of rest.slice(-wanted)) {
    const summary = said(s.summary);
    if (summary) scenes.push({ id: s.id, title: s.title, summary });
    else missing.push({ rung: 'scene', id: s.id, title: s.title });
  }

  // The current act. A chapter with no part is its own case rather than an
  // error: a book written without acts still has a level between scene and
  // book, and it is the whole book.
  const here = input.chapters.find((c) => c.id === input.chapterId);
  const chapters: LadderRung[] = [];
  if (here) {
    const siblings = input.chapters
      .filter((c) => c.partId === here.partId && c.rank < here.rank)
      .sort(byRank);
    for (const c of siblings) {
      const summary = said(c.summary);
      const title = c.title ?? (c.number === null ? null : `Chapter ${c.number}`);
      if (summary) chapters.push({ id: c.id, title, summary });
      else missing.push({ rung: 'chapter', id: c.id, title });
    }
  }

  const parts: LadderRung[] = [];
  const act = here && here.partId !== null
    ? input.parts.find((p) => p.id === here.partId)
    : undefined;
  if (act) {
    for (const p of input.parts.filter((p) => p.rank < act.rank).sort(byRank)) {
      const summary = said(p.summary);
      if (summary) parts.push({ id: p.id, title: p.title, summary });
      else missing.push({ rung: 'part', id: p.id, title: p.title });
    }
  }

  return { tail, scenes, chapters, parts, missing };
}
