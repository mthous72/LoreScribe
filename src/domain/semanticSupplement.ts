/**
 * Step 7 of the scene brief — the semantic supplement.
 *
 * [Doc 03](../../docs/03-story-graph-and-context.md): *vector search over
 * scene summaries, facts and notes, seeded by the scene's purpose and beat
 * text, excluding anything already included and anything the spoiler filter
 * rejected. Take the top few. This is the safety net for connections the
 * writer never linked — deliberately last, and deliberately small.*
 *
 * This is the filter, not the search. The retriever — vector, or `codex_fts`
 * and `scene_fts` with bm25 until an embedding model exists — hands over scored
 * candidates, and everything doc 03 says about what may *not* come back is
 * decided here, in one place, whichever retriever produced them. The search
 * itself has nothing to say about spoilers; swapping it must not be able to
 * change what the brief is allowed to contain.
 *
 * Four exclusions, in the order they are applied:
 *
 * 1. **Already included.** The scene itself, the working set, the facts step 3
 *    admitted, the scenes on the ladder. A hit on any of these is a hit on
 *    something the brief already carries in more detail.
 * 2. **Rejected by the spoiler filter.** Every fact step 3 judged and kept out
 *    — `excluded`, the whole list, not just the heavy ones in `negative`. A
 *    withheld fact too light to spend a line forbidding is still a fact the
 *    reader has not been told.
 * 3. **Not yet behind the reader.** A fact or scene the retriever found that
 *    step 3 never saw, because it is about somebody outside the working set,
 *    has still to pass the rank. For a scene that is its `global_rank`; for a
 *    fact it is the rank it was *revealed*, because established is exactly not
 *    enough — that distinction is the whole of step 4. A fact never stated on
 *    the page never passes. Notes and entities are not placed in the book and
 *    are not gated; a note is the one source here with no spoiler protection at
 *    all, and the writer's own, which is why it is admitted and why the
 *    repository may choose which kinds to offer.
 * 4. **The reference band.** Imported source material has its own slice in
 *    step 8b, budgeted before this one; the schema says the two bands are
 *    *never mixed in retrieval*, and doc 03's budget names this row *canon band
 *    only*.
 *
 * Then the best chunk per owner, the top few by score, and a deterministic tie
 * order so two compilations of the same brief agree.
 */

import type { Briefed } from './sceneBrief';
import type { Ladder } from './continuityLadder';

export type OwnerTable = 'scene' | 'fact' | 'note' | 'entity';

export interface Candidate {
  ownerTable: OwnerTable;
  ownerId: string;
  /**
   * The rank from which the reader may see this. A scene's `global_rank`; a
   * fact's **revealed** rank. Null for a fact means never on the page. Ignored
   * for a note or entity, which have no position in the book.
   */
  readerRank: string | null;
  /** `embedding.source_band`, or `canon` for anything not from an import. */
  band: 'canon' | 'reference';
  /** Retriever-specific; higher is better. Only compared within one call. */
  score: number;
  title: string | null;
  text: string;
}

export interface SupplementHit {
  ownerTable: OwnerTable;
  ownerId: string;
  title: string | null;
  text: string;
  score: number;
}

export interface Supplement {
  /** What the retriever was asked. Shown in the inspector. */
  query: string;
  hits: SupplementHit[];
}

export interface SupplementInput {
  briefed: Briefed;
  /** Step 6, when it has run. Its scenes are already included. */
  ladder?: Ladder | null;
  atRank: string;
  candidates: readonly Candidate[];
  /** Doc 03: the top few. */
  limit?: number;
}

const DEFAULT_LIMIT = 5;

/** Which sources have a place in the book, and so take the rank gate. */
const PLACED: Record<OwnerTable, boolean> = {
  scene: true, fact: true, note: false, entity: false,
};

/**
 * What to search for — doc 03: *seeded by the scene's purpose and beat text*.
 *
 * Not the scene's prose, which would find scenes that sound like this one; and
 * not the cast's names, which would find what the working set already covers.
 * The purpose and the beats say what this scene is *for*, and the connections
 * the writer never linked are the ones that share a purpose, not a vocabulary.
 */
export function supplementQuery(briefed: Briefed): string {
  const parts = [
    briefed.scene.purpose,
    ...briefed.beats.flatMap((b) => [b.title, b.summary]),
  ];
  return parts.map((p) => p?.trim()).filter(Boolean).join('\n');
}

export function semanticSupplement(input: SupplementInput): Supplement {
  const { briefed, atRank } = input;
  const limit = input.limit ?? DEFAULT_LIMIT;

  const included = new Set<string>([
    `scene:${briefed.scene.id}`,
    ...briefed.cast.map((e) => `entity:${e.entityId}`),
    ...briefed.setting.map((e) => `entity:${e.entityId}`),
    ...briefed.facts.map((f) => `fact:${f.factId}`),
    ...briefed.excluded.map((f) => `fact:${f.factId}`),
  ]);
  if (input.ladder) {
    if (input.ladder.tail) included.add(`scene:${input.ladder.tail.sceneId}`);
    for (const r of input.ladder.scenes) included.add(`scene:${r.id}`);
  }

  const best = new Map<string, Candidate>();
  for (const c of input.candidates) {
    if (c.band !== 'canon') continue;
    const key = `${c.ownerTable}:${c.ownerId}`;
    if (included.has(key)) continue;
    if (PLACED[c.ownerTable] && (c.readerRank === null || c.readerRank > atRank)) continue;
    const held = best.get(key);
    if (!held || c.score > held.score) best.set(key, c);
  }

  const hits = [...best.values()]
    .sort((a, b) =>
      b.score - a.score
      || a.ownerTable.localeCompare(b.ownerTable)
      || a.ownerId.localeCompare(b.ownerId))
    .slice(0, limit)
    .map((c) => ({
      ownerTable: c.ownerTable, ownerId: c.ownerId,
      title: c.title, text: c.text, score: c.score,
    }));

  return { query: supplementQuery(briefed), hits };
}
