import type { SourceNode } from './source';

/**
 * Two shapes a bible keeps its *plan* in, read without a model.
 *
 * **A rule list.** `laws.md` is a paragraph per law; `house-style.md` is a
 * bullet per rule. Both are "one rule per item", and the only judgement is
 * where an item ends: bullets when there are bullets, paragraphs otherwise.
 *
 * **An outline.** The commonest shape is headings for the acts, a numbered
 * heading per planned scene with its status in the tail — `4. Cal — not
 * written` — a paragraph of what it does, and a numbered list of what happens
 * in it. That is `part`, `chapter`+`scene`, `scene.summary` and `beat`,
 * one for one, and the beat is the unit the app writes in
 * ([D29](../../docs/10-decisions.md)). An outline imported as scenes-with-beats
 * is a book the compiler can aim at; imported as notes it is a book it can only
 * search.
 *
 * Nothing here decides. These read a shape and hand back a structure; whether
 * to import it is the writer's dropdown, as for everything else.
 */

/** `- `, `* `, `• ` at the start of a line. */
const BULLET = /^\s*[-*•]\s+(.*)$/u;
/** `4.`, `9b.` — a number, an optional letter, a dot, a space. */
const NUMBERED = /^\s*(\d+)([a-z]?)\.\s+(.*\S)\s*$/u;
/** The tail of a section heading: ` — not written`, ` – written. Next up.` */
const TAIL = /^(.*?)\s+[—–-]+\s+(.+)$/u;
const NOT_WRITTEN = /\bnot\s+(?:yet\s+)?written\b/iu;
const WRITTEN = /\b(?:written|drafted|done)\b/iu;
const ACT_PREFIX = /^(?:movement|act|part|book)\s+\w+[.:]?\s*/iu;

/** One rule per bullet where there are bullets, else one per paragraph. */
export function ruleItems(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const bullets = lines.map((l) => BULLET.exec(l)?.[1]?.trim()).filter((b): b is string => !!b);
  if (bullets.length >= 2) return bullets;
  return text.split(/\n\s*\n/u).map((p) => p.replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

/** The first sentence, cut to fit a title. */
export function firstClause(text: string, max = 60): string {
  const sentence = text.split(/(?<=[.!?])\s+/u)[0] ?? text;
  const clean = sentence.replace(/[.!?:;,]+$/u, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `Wren, dock clerk, male` is a name and a description that share a heading.
 *
 * Split only when the head is short enough to be a name and the tail is short
 * enough to be a line about it; anything else is left exactly as written. `Dex
 * and Holm` has no separator and stays one heading — two people in one entry
 * is the writer's to untangle, not a rule's to guess.
 */
export function splitName(heading: string): { name: string; rest: string | null } {
  const m = /^(.+?)(?:\s*[—–:]\s*|,\s+)(.+)$/u.exec(heading.trim());
  if (!m) return { name: heading.trim(), rest: null };
  const head = m[1]!.trim();
  const rest = m[2]!.trim();
  if (head.split(/\s+/u).length > 4 || head.length > 40 || rest.length > 80) {
    return { name: heading.trim(), rest: null };
  }
  return { name: head, rest };
}

export interface OutlineBeat {
  title: string;
  summary: string;
}

export interface OutlineSection {
  number: number | null;
  title: string;
  status: 'planned' | 'drafted';
  summary: string | null;
  beats: OutlineBeat[];
}

export interface OutlinePart {
  /** Null for an outline with no act headings — the sections sit at the top. */
  title: string | null;
  sections: OutlineSection[];
}

export interface Outline {
  title: string;
  parts: OutlinePart[];
}

/** Does this heading look like a planned scene? */
export const isSectionHeading = (heading: string | null): boolean =>
  heading !== null && NUMBERED.test(heading);

/**
 * Read an outline from the node that holds it.
 *
 * Sections are the numbered headings at any depth below `root`; a section's
 * act is the nearest non-numbered heading above it, below the root. Beats are
 * the numbered lines of the section's own text; whatever else the text says
 * is the section's summary.
 */
export function readOutline(root: SourceNode, title: string): Outline {
  const parts: OutlinePart[] = [];
  const partFor = (name: string | null): OutlinePart => {
    const last = parts[parts.length - 1];
    if (last && last.title === name) return last;
    const part = { title: name, sections: [] };
    parts.push(part);
    return part;
  };

  const visit = (node: SourceNode, act: string | null) => {
    for (const child of node.children) {
      const m = child.heading ? NUMBERED.exec(child.heading) : null;
      if (m) {
        partFor(act).sections.push(readSection(Number(m[1]), m[3]!, child));
        // Numbered headings nested under a numbered heading are still this
        // section's; do not descend.
        continue;
      }
      const name = child.heading ? child.heading.replace(ACT_PREFIX, '').trim() || child.heading : act;
      visit(child, child.heading ? name : act);
    }
  };
  visit(root, null);
  return { title, parts: parts.filter((p) => p.sections.length > 0) };
}

function readSection(number: number, rawTitle: string, node: SourceNode): OutlineSection {
  const tail = TAIL.exec(rawTitle);
  const title = (tail ? tail[1] : rawTitle)!.trim();
  const note = tail ? tail[2]!.trim() : '';
  const status: OutlineSection['status'] = NOT_WRITTEN.test(note) ? 'planned'
    : WRITTEN.test(note) ? 'drafted' : 'planned';
  // What the tail said beyond its status is the first line of the summary.
  const leftover = note.replace(NOT_WRITTEN, '').replace(WRITTEN, '').replace(/^[\s.,;:]+|[\s.,;:]+$/gu, '');

  const beats: OutlineBeat[] = [];
  const prose: string[] = [];
  for (const line of node.text.replace(/\r\n?/g, '\n').split('\n')) {
    const b = NUMBERED.exec(line);
    if (b) beats.push({ title: firstClause(b[3]!, 80), summary: b[3]!.trim() });
    else prose.push(line);
  }
  const body = prose.join('\n').split(/\n\s*\n/u).map((p) => p.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const summary = [leftover, ...body].filter(Boolean).join('\n\n') || null;
  return { number, title, status, summary, beats };
}
