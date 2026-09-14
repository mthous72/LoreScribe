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

import type { MentionRole } from './mentions';

/** How much of an entity the brief will carry. Step 5 renders to this. */
export type DossierDepth =
  /** Everything: description, filtered facts, voice notes. */
  | 'full'
  /** The standard entry: summary and description, no voice notes. */
  | 'standard'
  /** One line and nothing else — referred to, not on stage. */
  | 'name-only';

/** Why this entity is in the brief at all. Shown in the inspector. */
export type SeedVia = 'pov' | 'location' | 'mention';

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
