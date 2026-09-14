/**
 * Alias-matching mention detection.
 *
 * `mention` is derived data — a cache, rebuildable from prose plus the alias
 * list ([doc 02 §9b](../../docs/02-data-model.md)). It is what the scene brief
 * compiler seeds from, so its quality sets a ceiling on everything in Phase 2:
 * an entity the detector misses contributes nothing to a brief, and one it
 * invents wastes budget.
 *
 * Pure. Text and aliases in, spans and rows out, no database.
 */

/** Role in THIS scene, not importance in the book. docs/02 §mentions. */
export type MentionRole = 'pov' | 'focus' | 'present' | 'mentioned';

export interface AliasEntry {
  entityId: string;
  alias: string;
  /** A writer can switch off auto-linking for an alias that is too generic. */
  autoLink?: boolean;
  /**
   * An alias can itself be a spoiler — "the Grey Warden" only means Kaelen
   * after chapter 20. Before this scene rank, the alias is not linked, because
   * linking it would quietly tell the reader something the book hasn't yet.
   */
  linkableFromRank?: string | null;
}

export interface MentionSpan {
  entityId: string;
  /** The surface form actually found, not the canonical name. */
  alias: string;
  start: number;
  end: number;
  /**
   * True when the writer pointed at this entity rather than the matcher
   * finding it. Set by an `@` insert, which is the only way to link an alias
   * two entities share — those are ambiguous and `detectSpans` refuses them.
   */
  explicit?: boolean;
}

export interface MentionRow {
  entityId: string;
  role: MentionRole;
  /** First occurrence, for the jump-to-mention affordance. */
  startOffset: number;
  endOffset: number;
  aliasUsed: string;
  /** `explicit` when any of this entity's spans was placed by the writer. */
  method: 'alias_match' | 'explicit';
  occurrences: number;
}

export interface DetectOptions {
  /** Where this scene sits, for the spoiler-aware alias rule. */
  sceneRank?: string | null;
  /** Authored on the scene; `mention.role = 'pov'` is derived from it. */
  povEntityId?: string | null;
  /** At or above this many occurrences, an entity is 'present' not 'mentioned'. */
  presentThreshold?: number;
  /**
   * Links the writer placed by hand, merged with what the matcher finds.
   *
   * Passed in rather than detected here because they live in the stored
   * document's marks, not in its text — and they go through this function
   * rather than being appended by the caller so that one implementation
   * decides every role. Two places computing "is this entity present" would
   * disagree the first time the rule changed.
   */
  explicitSpans?: readonly MentionSpan[];
}

const DEFAULT_PRESENT_THRESHOLD = 2;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A letter, digit or underscore — what a word may not be adjacent to. */
const WORDY = /[\p{L}\p{N}_]/u;

function isBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1]! : '';
  const after = end < text.length ? text[end]! : '';
  // A trailing apostrophe is fine: "Kaelen's blade" mentions Kaelen. A trailing
  // letter is not: "Kaelenish" does not.
  return !(before && WORDY.test(before)) && !(after && WORDY.test(after));
}

export function usableAliases(aliases: readonly AliasEntry[], sceneRank?: string | null): AliasEntry[] {
  return aliases.filter((a) => {
    if (a.autoLink === false) return false;
    if (!a.alias.trim()) return false;
    if (a.linkableFromRank && sceneRank && sceneRank < a.linkableFromRank) return false;
    return true;
  });
}

/**
 * Build the matcher once and reuse it across scenes.
 *
 * Aliases are sorted longest-first because JavaScript alternation takes the
 * first branch that matches, not the longest: with "Warden" ahead of "the Grey
 * Warden", every occurrence of the full title would be recorded as the short
 * one and the distinction the writer drew would vanish.
 */
export function buildMatcher(aliases: readonly AliasEntry[]): {
  regex: RegExp;
  byAlias: Map<string, AliasEntry[]>;
} | null {
  const byAlias = new Map<string, AliasEntry[]>();
  for (const a of aliases) {
    const key = a.alias.toLowerCase();
    const at = byAlias.get(key);
    if (at) at.push(a);
    else byAlias.set(key, [a]);
  }
  const ordered = [...byAlias.keys()].sort((x, y) => y.length - x.length || x.localeCompare(y));
  if (!ordered.length) return null;
  return {
    regex: new RegExp(ordered.map(escapeRegExp).join('|'), 'giu'),
    byAlias,
  };
}

export function detectSpans(
  text: string, aliases: readonly AliasEntry[], options: DetectOptions = {},
): MentionSpan[] {
  const usable = usableAliases(aliases, options.sceneRank);
  const matcher = buildMatcher(usable);
  if (!matcher || !text) return [];

  const spans: MentionSpan[] = [];
  matcher.regex.lastIndex = 0;
  for (let m = matcher.regex.exec(text); m; m = matcher.regex.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isBoundary(text, start, end)) continue;
    const candidates = matcher.byAlias.get(m[0].toLowerCase());
    if (!candidates?.length) continue;
    // An alias shared by two entities is ambiguous and is NOT guessed at —
    // doc 08's product rules say an AI claim needs evidence, and the same
    // standard applies to a derived link the writer never asked for.
    if (candidates.length > 1) continue;
    spans.push({ entityId: candidates[0]!.entityId, alias: m[0], start, end });
  }
  return spans;
}

/**
 * Collapse spans into one row per entity.
 *
 * `focus` is never assigned here. pov is derived from the authored field and
 * present/mentioned from frequency, but focus is a judgement about what the
 * scene is *about*, which a substring count cannot make — the writer sets it.
 */
export function detectMentions(
  text: string,
  aliases: readonly AliasEntry[],
  options: DetectOptions = {},
): { spans: MentionSpan[]; mentions: MentionRow[] } {
  const found = detectSpans(text, aliases, options);
  const threshold = options.presentThreshold ?? DEFAULT_PRESENT_THRESHOLD;

  // An explicitly linked word is often also an alias the matcher found. Keep
  // the writer's span and drop the overlapping match, or the entity would be
  // counted twice and read as more present than it is.
  const explicit = (options.explicitSpans ?? []).map((s) => ({ ...s, explicit: true }));
  const overlaps = (a: MentionSpan, b: MentionSpan) => a.start < b.end && b.start < a.end;
  const spans = [
    ...explicit,
    ...found.filter((f) => !explicit.some((e) => overlaps(e, f))),
  ].sort((a, b) => a.start - b.start);

  const grouped = new Map<string, MentionSpan[]>();
  for (const s of spans) {
    const at = grouped.get(s.entityId);
    if (at) at.push(s);
    else grouped.set(s.entityId, [s]);
  }

  const mentions: MentionRow[] = [];
  for (const [entityId, hits] of grouped) {
    const first = hits[0]!;
    mentions.push({
      entityId,
      role: entityId === options.povEntityId
        ? 'pov'
        : hits.length >= threshold ? 'present' : 'mentioned',
      startOffset: first.start,
      endOffset: first.end,
      aliasUsed: first.alias,
      method: hits.some((h) => h.explicit) ? 'explicit' : 'alias_match',
      occurrences: hits.length,
    });
  }

  // The POV character is present whether or not they are named — a close-third
  // scene may never use the name, and a brief that omitted the POV would be
  // useless.
  if (options.povEntityId && !grouped.has(options.povEntityId)) {
    mentions.push({
      entityId: options.povEntityId,
      role: 'pov',
      startOffset: 0,
      endOffset: 0,
      aliasUsed: '',
      method: 'alias_match',
      occurrences: 0,
    });
  }

  const rank: Record<MentionRole, number> = { pov: 0, focus: 1, present: 2, mentioned: 3 };
  return {
    spans,
    mentions: mentions.sort((a, b) => rank[a.role] - rank[b.role] || b.occurrences - a.occurrences),
  };
}
