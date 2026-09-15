/**
 * Step 1 of the scene brief — the seed.
 *
 * [Doc 03 §"Compilation algorithm"](../../docs/03-story-graph-and-context.md):
 * *collect hard links from the scene row, weighted by the mention's role in this
 * scene rather than by book-level importance.*
 *
 * That clause is the whole of it, and it is easy to read past. A protagonist who
 * is merely named in passing gets one line here; a background clerk who is the
 * point of view gets everything. Weighting by `entity.importance` instead would
 * hand the model a full dossier on someone who is not in the room, and a
 * sentence about the person whose eyes the scene is told through — which is
 * precisely how a big-context dump behaves, and the thing this project exists to
 * beat.
 *
 * **POV and location come from the scene row, never from the mention index.**
 * `db/schema.sql` says it plainly: derived data is a cache, never the source of
 * truth. `mention` is rebuildable from scenes and aliases, and can be stale — it
 * is rebuilt on an idle timer while a writer types. The authored columns cannot
 * be. So a brief compiled a second after the POV changed is still right about
 * whose eyes it is written through, and the index supplies only the supporting
 * cast, where being a moment behind costs nothing.
 *
 * Pure, like `factVisibility`. It takes rows and returns a seed, so every rule
 * above can be tested without a database and there is exactly one statement of
 * each.
 */

import {
  factVisibilityAt, isKnowing, negativeConstraints,
  type FactForVisibility, type FactStatus,
} from './factVisibility';
import type { MentionRole } from './mentions';

/**
 * How much of an entity the brief will carry. Step 1 decides it from the role
 * in this scene; `renderDossiers` is where it is spent, and the table in that
 * step's header is the one statement of what each size includes.
 */
export type DossierDepth =
  /** Everything there is. */
  | 'full'
  /** The standard entry — everything but the voice notes. */
  | 'standard'
  /** Referred to, not on stage: the one line, and why they came up. */
  | 'name-only';

/** Why this entity is in the brief at all. Shown in the inspector. */
export type SeedVia = 'pov' | 'location' | 'mention' | 'relationship';

export interface EntityRow {
  id: string;
  name: string;
  typeKey: string;
  importance: string;
  summary: string | null;
  description: string | null;
}

export interface MentionRow {
  entityId: string;
  role: string;
  aliasUsed?: string | null;
}

export interface SceneRow {
  id: string;
  title: string | null;
  globalRank: string;
  purpose: string | null;
  summary: string | null;
  /** Authored. Not read from `mention`. */
  povEntityId: string | null;
  povMode: string | null;
  tense: string | null;
  /** Authored. Not read from `mention`. */
  locationEntityId: string | null;
  wordCount: number;
}

export interface BeatRow {
  beatId: string;
  title: string;
  summary: string | null;
  function: string | null;
  tension: number | null;
  /** The beat's role in THIS scene: setup | develop | payoff | echo. */
  role: string;
  arcId: string;
  arcName: string;
  arcKind: string;
}

export interface SeedEntity {
  entityId: string;
  name: string;
  typeKey: string;
  importance: string;
  summary: string | null;
  description: string | null;
  /** The role in this scene. `pov` here is the authored one. */
  role: MentionRole;
  depth: DossierDepth;
  via: SeedVia;
  aliasUsed?: string | null;
}

/** The brief's `scene:` block — what this scene is, as opposed to what it says. */
export interface SceneFacet {
  id: string;
  title: string | null;
  globalRank: string;
  purpose: string | null;
  povEntityId: string | null;
  povEntityName: string | null;
  povMode: string | null;
  tense: string | null;
  locationEntityId: string | null;
  locationName: string | null;
  wordCount: number;
}

export interface Seed {
  scene: SceneFacet;
  /** People and things in the scene, strongest role first. */
  cast: SeedEntity[];
  /** Where it happens. A list because a scene can move. */
  setting: SeedEntity[];
  /** What this scene has to accomplish. Empty is a real answer, and a loud one. */
  beats: BeatTarget[];
  /** Anything the seed could not resolve, named rather than dropped silently. */
  unresolved: { kind: 'entity' | 'location' | 'pov'; id: string }[];
}

export interface BeatTarget {
  beatId: string;
  title: string;
  summary: string | null;
  function: string | null;
  tension: number | null;
  role: string;
  arcId: string;
  arcName: string;
  arcKind: string;
}

export interface SeedInput {
  scene: SceneRow;
  /** The derived cache. May be stale; may be empty. */
  mentions: readonly MentionRow[];
  /** Everything the rows above refer to, by id. */
  entities: ReadonlyMap<string, EntityRow>;
  beats: readonly BeatRow[];
}

/** Doc 03's weighting, and the only place it is written down. */
const DEPTH: Record<MentionRole, DossierDepth> = {
  pov: 'full',
  focus: 'full',
  present: 'standard',
  mentioned: 'name-only',
};

const ROLE_RANK: Record<MentionRole, number> = {
  pov: 0, focus: 1, present: 2, mentioned: 3,
};

const asRole = (raw: string): MentionRole =>
  (raw in ROLE_RANK ? raw : 'mentioned') as MentionRole;

export function seedBrief(input: SeedInput): Seed {
  const { scene, entities } = input;
  const unresolved: Seed['unresolved'] = [];
  const look = (id: string, kind: 'entity' | 'location' | 'pov') => {
    const row = entities.get(id);
    // Named, not dropped. A brief that silently omits the POV because the row
    // did not come back looks identical to a scene with no POV, and the writer
    // would have no way to tell which they are reading.
    if (!row) unresolved.push({ kind, id });
    return row;
  };

  const povRow = scene.povEntityId ? look(scene.povEntityId, 'pov') : undefined;
  const locationRow = scene.locationEntityId
    ? look(scene.locationEntityId, 'location')
    : undefined;

  // Strongest role wins where an entity is mentioned more than once. The rows
  // are a cache of a detection pass, and a name that appears as `present` early
  // and `focus` later is one character, at the stronger of the two.
  const byEntity = new Map<string, MentionRole>();
  for (const m of input.mentions) {
    const role = asRole(m.role);
    const held = byEntity.get(m.entityId);
    if (held === undefined || ROLE_RANK[role] < ROLE_RANK[held]) byEntity.set(m.entityId, role);
  }
  const aliasOf = new Map<string, string | null>();
  for (const m of input.mentions) {
    if (!aliasOf.has(m.entityId)) aliasOf.set(m.entityId, m.aliasUsed ?? null);
  }

  const cast: SeedEntity[] = [];
  const seen = new Set<string>();

  const push = (row: EntityRow, role: MentionRole, via: SeedVia) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    cast.push({
      entityId: row.id, name: row.name, typeKey: row.typeKey,
      importance: row.importance, summary: row.summary, description: row.description,
      role, depth: DEPTH[role], via,
      ...(aliasOf.has(row.id) ? { aliasUsed: aliasOf.get(row.id) ?? null } : {}),
    });
  };

  // The POV first and from the scene row, so a stale index cannot cost the brief
  // the one entity it is most about.
  if (povRow) push(povRow, 'pov', 'pov');

  // The location does not belong in the cast: it is where, not who. Claimed
  // before the mention pass so a place named in the prose is not also listed as
  // a character who was standing there.
  const setting: SeedEntity[] = [];
  if (locationRow) {
    seen.add(locationRow.id);
    setting.push({
      entityId: locationRow.id, name: locationRow.name, typeKey: locationRow.typeKey,
      importance: locationRow.importance, summary: locationRow.summary,
      description: locationRow.description,
      role: 'present', depth: 'standard', via: 'location',
    });
  }

  for (const [entityId, role] of byEntity) {
    const row = look(entityId, 'entity');
    if (row) push(row, role, 'mention');
  }

  cast.sort((a, b) =>
    ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name, 'en'));

  return {
    scene: {
      id: scene.id,
      title: scene.title,
      globalRank: scene.globalRank,
      purpose: scene.purpose,
      povEntityId: scene.povEntityId,
      povEntityName: povRow?.name ?? null,
      povMode: scene.povMode,
      tense: scene.tense,
      locationEntityId: scene.locationEntityId,
      locationName: locationRow?.name ?? null,
      wordCount: scene.wordCount,
    },
    cast,
    setting,
    beats: input.beats.map((b) => ({
      beatId: b.beatId, title: b.title, summary: b.summary, function: b.function,
      tension: b.tension, role: b.role,
      arcId: b.arcId, arcName: b.arcName, arcKind: b.arcKind,
    })),
    unresolved,
  };
}

/* ------------------------------------------------- step 2: expand one hop */

/**
 * Step 2 of the brief — [doc 03](../../docs/03-story-graph-and-context.md):
 * *from each seed entity, traverse `entity_relationship` where the relationship
 * is active at this scene's rank. One hop, not two — two-hop expansion pulls in
 * the whole world and defeats the purpose. Second-hop entities are admitted only
 * if they also appear in this scene's beats.*
 *
 * The temporal test is the same one the facts take: active means it had started
 * by this point and has not ended. Written out here rather than shared with
 * `factVisibility`, because the two answer different questions — a fact that
 * ends is invalidated and may still be worth naming as wrong, while a
 * relationship that ends simply is not a relationship any more.
 *
 * **A secret relationship does not expand, and doc 03 does not say so.** This is
 * a deliberate addition. Step 4's spoiler filter protects *facts*; relationships
 * never pass through it, so a secret one traversed here would put its other end
 * in the brief with no spoiler check at all — "the Grey Warden" expanded to
 * Kaelen in chapter five, which is exactly what the temporal model exists to
 * prevent. Unlike a fact there is no `revealed_at` to consult, only a boolean,
 * so the conservative direction is the only defensible one: reasoning from no
 * evidence toward disclosure is backwards. A secret relationship is a candidate
 * for the negative-constraints block in step 8, where naming it as forbidden is
 * safe; it is not a candidate for expansion.
 */

export interface RelationshipRow {
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  label: string | null;
  strength: number | null;
  isSecret: boolean;
  /** Resolved from `since_scene_id`. Null means it always held. */
  sinceRank: string | null;
  /** Resolved from `until_scene_id`. Null means it still holds. */
  untilRank: string | null;
}

/** How a neighbour got in, and what it is to the entity that brought it. */
export interface SeedLink {
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  label: string | null;
  strength: number | null;
  /** 1 for a direct neighbour of the scene; 2 for one admitted by a beat. */
  hop: 1 | 2;
}

export interface Expanded extends Seed {
  links: SeedLink[];
}

export interface ExpandInput {
  seed: Seed;
  /** The scene's `global_rank`. Ranks compare lexicographically. */
  atRank: string;
  relationships: readonly RelationshipRow[];
  entities: ReadonlyMap<string, EntityRow>;
  /** Other names an entity answers to, for the second-hop beat check. */
  aliases?: ReadonlyMap<string, readonly string[]>;
}

const active = (r: RelationshipRow, at: string): boolean =>
  (r.sinceRank === null || r.sinceRank <= at)
  && (r.untilRank === null || r.untilRank > at);

/** What the beats of this scene actually say, lowercased once. */
const beatProse = (seed: Seed): string =>
  seed.beats.map((b) => `${b.title} ${b.summary ?? ''}`).join(' ').toLowerCase();

export function expandOneHop(input: ExpandInput): Expanded {
  const { seed, atRank, entities } = input;
  // Copies, not the seed's own arrays. Step 1 is pure and this has to be too,
  // or a caller that compiles a brief twice gets a different answer the second
  // time.
  const cast = [...seed.cast];
  const unresolved = [...seed.unresolved];
  const links: SeedLink[] = [];
  const known = new Set<string>([
    ...seed.cast.map((c) => c.entityId),
    ...seed.setting.map((s) => s.entityId),
  ]);
  // One row per pair, so being somebody's sister is one link however many
  // entities in the scene are standing at either end of it.
  const taken = new Set<RelationshipRow>();

  // Both directions: `entity_relationship` stores one row per pair, and being
  // somebody's sister is the same fact read either way round.
  const neighbours = (id: string) => {
    const out: { other: string; row: RelationshipRow }[] = [];
    for (const r of input.relationships) {
      if (r.isSecret || !active(r, atRank)) continue;
      if (r.fromEntityId === id) out.push({ other: r.toEntityId, row: r });
      else if (r.toEntityId === id) out.push({ other: r.fromEntityId, row: r });
    }
    return out;
  };

  const admit = (from: string, other: string, row: RelationshipRow, hop: 1 | 2) => {
    if (!taken.has(row)) {
      taken.add(row);
      links.push({
        fromEntityId: from, toEntityId: other, kind: row.kind,
        label: row.label, strength: row.strength, hop,
      });
    }
    if (known.has(other)) return false;
    const entity = entities.get(other);
    if (!entity) {
      unresolved.push({ kind: 'entity', id: other });
      return false;
    }
    known.add(other);
    cast.push({
      entityId: entity.id, name: entity.name, typeKey: entity.typeKey,
      importance: entity.importance, summary: entity.summary,
      description: entity.description,
      // Not in the scene, so not a member of it: one line, and the link says
      // what they are to somebody who is.
      role: 'mentioned', depth: 'name-only', via: 'relationship',
    });
    return true;
  };

  const firstHop: string[] = [];
  for (const seedEntity of [...seed.cast, ...seed.setting]) {
    for (const { other, row } of neighbours(seedEntity.entityId)) {
      if (admit(seedEntity.entityId, other, row, 1)) firstHop.push(other);
    }
  }

  // The one exception doc 03 allows, and the only reason a second hop exists:
  // a beat that names somebody two steps away is the writer saying this scene
  // is about them. Nothing else earns a second hop, and there is never a third.
  const prose = beatProse(seed);
  if (prose.trim()) {
    const named = (id: string): boolean => {
      const entity = entities.get(id);
      if (!entity) return false;
      const names = [entity.name, ...(input.aliases?.get(id) ?? [])];
      return names.some((n) => n.trim() && prose.includes(n.toLowerCase()));
    };
    for (const id of firstHop) {
      for (const { other, row } of neighbours(id)) {
        if (!known.has(other) && named(other)) admit(id, other, row, 2);
      }
    }
  }

  cast.sort((a, b) =>
    ROLE_RANK[a.role] - ROLE_RANK[b.role]
    || (a.via === 'relationship' ? 1 : 0) - (b.via === 'relationship' ? 1 : 0)
    || a.name.localeCompare(b.name, 'en'));

  return { ...seed, cast, links, unresolved };
}

/* --------------------------------------- step 3: the facts, filtered in time */

/**
 * Steps 3 and 4 of the brief — the temporal filter and the spoiler filter.
 *
 * Both rules already exist, exhaustively tested, in
 * [`factVisibility`](./factVisibility.ts), and they stay there: *a spoiler rule
 * implemented twice is a spoiler rule that disagrees with itself, and the
 * failure mode is telling a reader something the book has not told them yet.*
 * So this step does not restate either rule. Its job is the part doc 03 leaves
 * to the compiler — deciding **which facts get asked about**, and what to do
 * with the answers.
 *
 * Three decisions, none of them in doc 03, all of them load-bearing:
 *
 * **A fact is selected by its subject.** Doc 03 says *for each entity in the
 * working set, select facts*, and a `fact` row points at two entities: a
 * subject and, sometimes, an object. Selecting on either end would pull in
 * "Ilva is the Warden's sister" when only the Warden is in the room, and step 5
 * renders facts underneath the entity they are about — so that fact would
 * arrive with no dossier to sit under, naming somebody who is not in the brief.
 * What the two entities are to each other is already carried by step 2's
 * `links`; a fact reached only through its object end is exactly what step 7's
 * semantic supplement is the safety net for.
 *
 * **A fact with no subject is not a fact for a brief.** The column is nullable,
 * and a subject-less fact is a statement about the world with no dossier to
 * belong to. That is a law, and laws are step 8.
 *
 * **Which beliefs count as knowing is decided once, in `factVisibility`.**
 * `fact_knowledge.belief` is one of `knows | suspects | believes_false |
 * denies`, and `factVisibilityAt` takes a flat map of who-knows-when — so
 * somebody has to fold the column, and this step does it with `isKnowing`, the
 * same predicate the facts page uses. A POV who *believes a thing false* does
 * not know it, and admitting that would let the spoiler rule reveal a fact to a
 * character who has been lied to. A POV who *suspects* does have it in mind and
 * can act on it; the belief is carried through on `povBelief` so step 9 can say
 * *suspects* rather than *knows*, and the model does not write a suspicion as
 * settled.
 *
 * Certainty (`canon | planned | speculative`) is carried, not filtered. A
 * speculative fact is one the writer has not settled, and both silently
 * dropping it and silently presenting it as canon are wrong; labelling it is
 * step 5's job, and this step keeps to one.
 */

/** A `v_fact_ranks` row with its `fact_knowledge` rows attached. */
export interface FactRow {
  id: string;
  subjectEntityId: string | null;
  objectEntityId: string | null;
  predicate: string;
  statement: string;
  /** canon | planned | speculative. Carried, not filtered. */
  certainty: string;
  spoilerWeight: number;
  isDramaticIrony: boolean;
  establishedRank: string | null;
  revealedRank: string | null;
  invalidatedRank: string | null;
  supersedesFactId: string | null;
  knowledge?: readonly {
    entityId: string;
    /** knows | suspects | believes_false | denies. */
    belief: string;
    knownFromRank: string | null;
  }[];
}

export type Belief = 'knows' | 'suspects' | 'believes_false' | 'denies';

export interface BriefFact {
  factId: string;
  subjectEntityId: string;
  objectEntityId: string | null;
  predicate: string;
  statement: string;
  certainty: string;
  spoilerWeight: number;
  /** `reader-knows`, `dramatic-irony` or `pov-knows` — the three that pass. */
  status: FactStatus;
  /** What the point-of-view character makes of it, when they have a view. */
  povBelief: Belief | null;
}

/** Doc 03 §4: "do not reveal, hint at, or foreshadow X." */
export interface NegativeFact {
  factId: string;
  subjectEntityId: string;
  statement: string;
  spoilerWeight: number;
  /** Why it is out. A withheld secret and an unwritten future read differently. */
  status: FactStatus;
}

/** A fact of the working set that was judged and kept out, and why. */
export interface ExcludedFact {
  factId: string;
  status: FactStatus;
}

export interface Briefed extends Expanded {
  /** What may be used, most important to this scene first. */
  facts: BriefFact[];
  /** What must not be said, heaviest first. */
  negative: NegativeFact[];
  /**
   * Everything judged and kept out — the heavy ones in `negative` and the rest.
   * Step 7 needs the whole list: a withheld fact too light for the negative
   * block is still a fact the reader has not been told, and a semantic hit on
   * it would otherwise carry it straight past the filter that rejected it.
   */
  excluded: ExcludedFact[];
}

export interface AttachInput {
  expanded: Expanded;
  /** The scene's `global_rank`. */
  atRank: string;
  /**
   * Candidate facts. Every fact whose subject is in the working set, **plus any
   * fact that supersedes one of those** — supersession is a relation, and a
   * replacement missing from this list leaves the fact it replaces looking
   * current. Handing over more than that is harmless: selection happens here.
   */
  facts: readonly FactRow[];
}

const asBelief = (raw: string): Belief | null =>
  (['knows', 'suspects', 'believes_false', 'denies'] as const)
    .find((b) => b === raw) ?? null;

export function attachFacts(input: AttachInput): Briefed {
  const { expanded, atRank } = input;

  // Position in the working set, which steps 1 and 2 have already sorted by
  // role in *this scene*. Using it as the first sort key is the same argument
  // as step 1's: what matters is who this scene is about, not who the book is.
  const order = new Map<string, number>();
  [...expanded.cast, ...expanded.setting].forEach((e, i) => {
    if (!order.has(e.entityId)) order.set(e.entityId, i);
  });

  const pov = expanded.scene.povEntityId;
  const beliefOf = (f: FactRow): Belief | null => {
    if (!pov) return null;
    const row = f.knowledge?.find((k) => k.entityId === pov);
    return row ? asBelief(row.belief) : null;
  };

  const forVisibility: FactForVisibility[] = input.facts.map((f) => {
    const knownFrom: Record<string, string | null> = {};
    for (const k of f.knowledge ?? []) {
      if (isKnowing(k.belief)) knownFrom[k.entityId] = k.knownFromRank;
    }
    return {
      id: f.id,
      establishedRank: f.establishedRank,
      revealedRank: f.revealedRank,
      invalidatedRank: f.invalidatedRank,
      supersedesFactId: f.supersedesFactId,
      isDramaticIrony: f.isDramaticIrony,
      spoilerWeight: f.spoilerWeight,
      knownFrom,
    };
  });

  // Judged over everything handed in, so a superseding fact about somebody who
  // is not in the room still does its work; selected afterwards.
  const visibility = factVisibilityAt(forVisibility, atRank, { povEntityId: pov });

  const mine = input.facts.filter((f) =>
    f.subjectEntityId !== null && order.has(f.subjectEntityId));

  const facts: BriefFact[] = [];
  const excluded: ExcludedFact[] = [];
  for (const f of mine) {
    const seen = visibility.get(f.id);
    if (!seen?.include) {
      excluded.push({ factId: f.id, status: seen?.status ?? 'withheld' });
      continue;
    }
    facts.push({
      factId: f.id,
      subjectEntityId: f.subjectEntityId as string,
      objectEntityId: f.objectEntityId,
      predicate: f.predicate,
      statement: f.statement,
      certainty: f.certainty,
      spoilerWeight: f.spoilerWeight,
      status: seen.status,
      povBelief: beliefOf(f),
    });
  }

  // Doc 03 §9 trims facts by importance, spoiler weight and recency, from the
  // tail. Sorting by exactly those three here is what makes that a truncation
  // rather than a decision taken twice. Recency is the rank the fact became
  // true, latest first; backstory sorts as the empty string, which is to say
  // last, because it is the oldest thing in the book.
  const establishedAt = new Map(mine.map((f) => [f.id, f.establishedRank ?? '']));
  const since = (id: string) => establishedAt.get(id) ?? '';
  facts.sort((a, b) =>
    (order.get(a.subjectEntityId) ?? 0) - (order.get(b.subjectEntityId) ?? 0)
    || b.spoilerWeight - a.spoilerWeight
    || since(b.factId).localeCompare(since(a.factId))
    || a.factId.localeCompare(b.factId));

  const dangerous = new Set(
    negativeConstraints(forVisibility, visibility).map((f) => f.id));
  const negative: NegativeFact[] = mine
    .filter((f) => dangerous.has(f.id))
    .map((f) => ({
      factId: f.id,
      subjectEntityId: f.subjectEntityId as string,
      statement: f.statement,
      spoilerWeight: f.spoilerWeight,
      status: visibility.get(f.id)?.status ?? 'withheld',
    }))
    .sort((a, b) =>
      b.spoilerWeight - a.spoilerWeight
      || (order.get(a.subjectEntityId) ?? 0) - (order.get(b.subjectEntityId) ?? 0)
      || a.factId.localeCompare(b.factId));

  return { ...expanded, facts, negative, excluded };
}

/* ----------------------------------------------- step 5: render the dossiers */

/**
 * Step 5 — each entity becomes an entry sized to what it is in this scene.
 *
 * **Doc 03 says "sized by `importance`", and this sizes by `depth`.** The two
 * sentences are in the same document and they contradict each other: step 1
 * says *weighted by the mention's role in this scene rather than by book-level
 * importance*, and step 5 says the opposite. Step 1 is the one the project is
 * built on — a protagonist named in passing gets one line, a background clerk
 * who holds the point of view gets everything — so `depth`, which step 1
 * computed from the role and step 2 assigned to everyone it dragged in, is what
 * sizes the entry. Reading step 5 literally would undo step 1 at the last
 * moment and hand the model a full dossier on somebody who is not in the room,
 * which is precisely the big-context behaviour this pipeline exists to beat.
 *
 * What each size carries:
 *
 * | | summary | description | facts | links | voice |
 * |---|---|---|---|---|---|
 * | `full` | ✓ | ✓ | ✓ | ✓ | ✓ |
 * | `standard` | ✓ | ✓ | ✓ | ✓ | |
 * | `name-only` | ✓ | | | ✓ | |
 *
 * A name-only entry keeps its links, and that is deliberate: step 2 admitted
 * most of these *because* of a link, and a bare name with no reason to be in
 * the brief costs the same tokens while telling the model nothing. "Renn —
 * Ilva's sister" is the one line.
 *
 * **Two columns are deliberately not rendered, for the same reason.**
 * `entity.status` (`alive | dead | destroyed`) and `entity.attributes` carry no
 * rank. They are the state of the world at the end of the book, so putting
 * either into a brief compiled for chapter five announces a death the reader
 * has not reached — the same failure as an unfiltered secret relationship in
 * step 2, arriving through a column nobody thinks of as temporal. A death that
 * matters is a fact, facts have ranks, and step 3 has already decided whether
 * this scene may know about it.
 *
 * **Aliases are rank-filtered, because the schema says they can be spoilers.**
 * `entity_alias.linkable_from_scene_id` exists for exactly one case, and the
 * schema names it: *an alias may itself be a spoiler ("the Grey Warden" ==
 * Kaelen, ch.20)*. An alias list assembled without that filter would equate the
 * two in chapter five inside the very section meant to help the model use the
 * right name.
 */

/** An `entity_alias` row with its gate resolved to a rank. */
export interface AliasRow {
  entityId: string;
  alias: string;
  kind: string | null;
  /** From `linkable_from_scene_id`. Null = usable from the start. */
  linkableFromRank: string | null;
}

/**
 * A voice law, already narrowed by the caller.
 *
 * These are `law` rows with `category = 'voice'`: entity-scoped ones for
 * everybody, and `pov`-scoped ones only when that entity holds the point of
 * view. The repository knows the scene's POV and does that narrowing; this step
 * only decides who is important enough to spend the lines on. Step 8 gathers
 * the laws covering the scene and must not list these again.
 */
export interface VoiceNote {
  entityId: string;
  title: string;
  ruleText: string;
  /** must | should | prefer. */
  severity: string;
}

export interface DossierLink {
  otherEntityId: string;
  otherName: string;
  kind: string;
  label: string | null;
  strength: number | null;
}

export interface Dossier {
  entityId: string;
  name: string;
  typeKey: string;
  /** Book-level. Carried for step 9's trim, never used to size this entry. */
  importance: string;
  role: MentionRole;
  depth: DossierDepth;
  via: SeedVia;
  /** The name the prose actually used, when the mention index caught one. */
  aliasUsed: string | null;
  /** Other names, already filtered to the ones usable by this point. */
  aliases: string[];
  summary: string | null;
  /** `full` and `standard` only. */
  description: string | null;
  /** Everything step 3 admitted about this entity, in its order. */
  facts: BriefFact[];
  /** What this entity is to others in the brief. */
  links: DossierLink[];
  /** `full` only. */
  voice: VoiceNote[];
}

export interface Dossiered extends Briefed {
  /** Cast first, then setting — the order steps 1 and 2 put them in. */
  dossiers: Dossier[];
}

export interface DossierInput {
  briefed: Briefed;
  /** The scene's `global_rank`, for the alias gate. */
  atRank: string;
  aliases?: readonly AliasRow[];
  voiceNotes?: readonly VoiceNote[];
}

export function renderDossiers(input: DossierInput): Dossiered {
  const { briefed, atRank } = input;
  const people = [...briefed.cast, ...briefed.setting];
  const nameOf = new Map(people.map((e) => [e.entityId, e.name]));

  const factsFor = new Map<string, BriefFact[]>();
  for (const f of briefed.facts) {
    const held = factsFor.get(f.subjectEntityId);
    if (held) held.push(f);
    else factsFor.set(f.subjectEntityId, [f]);
  }

  const aliasFor = new Map<string, string[]>();
  for (const a of input.aliases ?? []) {
    if (a.linkableFromRank !== null && a.linkableFromRank > atRank) continue;
    const held = aliasFor.get(a.entityId) ?? [];
    held.push(a.alias);
    aliasFor.set(a.entityId, held);
  }

  const voiceFor = new Map<string, VoiceNote[]>();
  for (const v of input.voiceNotes ?? []) {
    const held = voiceFor.get(v.entityId) ?? [];
    held.push(v);
    voiceFor.set(v.entityId, held);
  }

  // A link whose other end never resolved has no name to render. It is already
  // named in `unresolved`, which is where a missing row belongs.
  const linksFor = (id: string): DossierLink[] => {
    const out: DossierLink[] = [];
    for (const l of briefed.links) {
      const other = l.fromEntityId === id ? l.toEntityId
        : l.toEntityId === id ? l.fromEntityId : null;
      if (other === null) continue;
      const name = nameOf.get(other);
      if (name === undefined) continue;
      out.push({
        otherEntityId: other, otherName: name,
        kind: l.kind, label: l.label, strength: l.strength,
      });
    }
    return out;
  };

  const dossiers = people.map((e): Dossier => {
    const thin = e.depth === 'name-only';
    const aliases = [...new Set(aliasFor.get(e.entityId) ?? [])]
      .filter((a) => a.toLowerCase() !== e.name.toLowerCase());
    return {
      entityId: e.entityId,
      name: e.name,
      typeKey: e.typeKey,
      importance: e.importance,
      role: e.role,
      depth: e.depth,
      via: e.via,
      aliasUsed: e.aliasUsed ?? null,
      aliases: thin ? [] : aliases,
      summary: e.summary,
      description: thin ? null : e.description,
      facts: thin ? [] : (factsFor.get(e.entityId) ?? []),
      links: linksFor(e.entityId),
      voice: e.depth === 'full' ? (voiceFor.get(e.entityId) ?? []) : [],
    };
  });

  return { ...briefed, dossiers };
}
