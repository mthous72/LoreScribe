/**
 * Structural gap finder — docs/12 §8.
 *
 * Deterministic, no model, fast enough to run on every save. Built BEFORE the
 * AI continuity checker deliberately: it is free, instant, and catches a
 * surprising share of the problems people reach for a model to find.
 *
 * Pure, like everything in the domain layer — plain objects in, plain objects
 * out, no database and no platform. That is what makes it testable without a
 * browser, and it is where the product's value actually lives (doc 01).
 */

export type GapType =
  | 'dangling_reference'
  | 'out_of_range_reference'
  | 'unresolved_thread'
  | 'unresolved_arc'
  | 'thin_entity'
  | 'missing_voice_profile'
  | 'orphan_scene'
  | 'unrealised_beat';

export type Severity = 'error' | 'warning' | 'info';

export interface Gap {
  id: string;
  type: GapType;
  severity: Severity;
  entityType: string;
  entityName: string;
  message: string;
  /** The offending text, so the row can be believed without opening it. */
  evidence?: string;
  /** Makes the row click-to-open. */
  target: { table: string; id: string };
}

export interface GapEntity {
  id: string;
  name: string;
  typeKey: string;
  summary?: string | null;
  importance?: string | null;
  /** Present on a character who speaks; its absence is the gap. */
  voiceProfile?: string | null;
  speaks?: boolean;
}

export interface GapScene {
  id: string;
  title?: string | null;
  globalRank: string;
  /** A scene with prose but no beat is an orphan; an empty one is just unwritten. */
  wordCount?: number;
}

export interface GapChapter { id: string; number?: number | null; title?: string | null }

export interface GapBeat {
  id: string;
  title: string;
  arcId?: string | null;
  /** Display number of the chapter this beat is meant to land in. */
  targetChapterNumber?: number | null;
  sceneIds: string[];
}

export interface GapArc {
  id: string;
  name: string;
  /** Where the arc is meant to resolve. */
  resolvesAtSceneId?: string | null;
  resolved?: boolean;
}

export interface GapThread {
  id: string;
  name: string;
  kind: string;
  resolvesBySceneId?: string | null;
  resolvedAtSceneId?: string | null;
}

/** A name mentioned in a relational field, extracted by the caller. */
export interface GapReference {
  ownerTable: string;
  ownerId: string;
  ownerName: string;
  field: string;
  name: string;
}

export interface GapInput {
  entities: GapEntity[];
  aliases: { entityId: string; alias: string }[];
  scenes: GapScene[];
  chapters: GapChapter[];
  beats: GapBeat[];
  arcs: GapArc[];
  threads: GapThread[];
  references: GapReference[];
  /** The scene the manuscript has reached, for "past its resolution point". */
  currentSceneId?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export function findGaps(input: GapInput): Gap[] {
  const gaps: Gap[] = [];
  const push = (g: Omit<Gap, 'id'>) =>
    gaps.push({ ...g, id: `${g.type}:${g.target.table}:${g.target.id}:${g.entityName}` });

  const known = new Set<string>();
  for (const e of input.entities) known.add(norm(e.name));
  for (const a of input.aliases) known.add(norm(a.alias));

  // --- a name used in a relational field with no matching entity or alias
  for (const ref of input.references) {
    if (known.has(norm(ref.name))) continue;
    push({
      type: 'dangling_reference',
      severity: 'error',
      entityType: ref.ownerTable,
      entityName: ref.ownerName,
      message: `"${ref.name}" is referenced but no entity or alias matches it.`,
      evidence: `${ref.field}: ${ref.name}`,
      target: { table: ref.ownerTable, id: ref.ownerId },
    });
  }

  // --- a beat aimed at a chapter that does not exist
  const chapterNumbers = new Set(
    input.chapters.map((c) => c.number).filter((n): n is number => n != null),
  );
  for (const beat of input.beats) {
    const n = beat.targetChapterNumber;
    if (n == null || chapterNumbers.has(n)) continue;
    push({
      type: 'out_of_range_reference',
      severity: 'error',
      entityType: 'beat',
      entityName: beat.title,
      message: `Targets chapter ${n}, which does not exist.`,
      evidence: `target chapter ${n}`,
      target: { table: 'beat', id: beat.id },
    });
  }

  const rankOf = new Map(input.scenes.map((s) => [s.id, s.globalRank]));
  const currentRank = input.currentSceneId ? rankOf.get(input.currentSceneId) : undefined;
  const isPast = (sceneId?: string | null) => {
    if (!sceneId || currentRank === undefined) return false;
    const r = rankOf.get(sceneId);
    return r !== undefined && r <= currentRank;
  };

  // --- promises the manuscript has passed without keeping
  for (const thread of input.threads) {
    if (thread.resolvedAtSceneId) continue;
    if (!isPast(thread.resolvesBySceneId)) continue;
    push({
      type: 'unresolved_thread',
      severity: 'warning',
      entityType: 'thread',
      entityName: thread.name,
      message: `This ${thread.kind} was meant to resolve by now and has not.`,
      target: { table: 'narrative_thread', id: thread.id },
    });
  }

  for (const arc of input.arcs) {
    if (arc.resolved) continue;
    if (!isPast(arc.resolvesAtSceneId)) continue;
    push({
      type: 'unresolved_arc',
      severity: 'warning',
      entityType: 'arc',
      entityName: arc.name,
      message: 'The manuscript is past this arc’s resolution point and it is still open.',
      target: { table: 'arc', id: arc.id },
    });
  }

  // --- entities too thin for the brief compiler to say anything about
  for (const e of input.entities) {
    if (e.importance === 'background') continue; // a spear-carrier needs no dossier
    if (!e.summary || !e.summary.trim()) {
      push({
        type: 'thin_entity',
        severity: 'warning',
        entityType: e.typeKey,
        entityName: e.name,
        message: 'No summary, so this contributes nothing to a scene brief.',
        target: { table: 'entity', id: e.id },
      });
    }
    if (e.speaks && !(e.voiceProfile && e.voiceProfile.trim())) {
      push({
        type: 'missing_voice_profile',
        severity: 'info',
        entityType: e.typeKey,
        entityName: e.name,
        message: 'Speaks on the page but has no voice profile, so dialogue has nothing to follow.',
        target: { table: 'entity', id: e.id },
      });
    }
  }

  // --- structure: the two the SQL views also expose
  const scenesWithBeats = new Set(input.beats.flatMap((b) => b.sceneIds));
  for (const scene of input.scenes) {
    if (scenesWithBeats.has(scene.id)) continue;
    if (!scene.wordCount) continue; // unwritten is not orphaned
    push({
      type: 'orphan_scene',
      severity: 'info',
      entityType: 'scene',
      entityName: scene.title ?? 'Untitled scene',
      message: 'Written, but serves no beat in any arc.',
      target: { table: 'scene', id: scene.id },
    });
  }

  for (const beat of input.beats) {
    if (beat.sceneIds.length > 0) continue;
    push({
      type: 'unrealised_beat',
      severity: 'info',
      entityType: 'beat',
      entityName: beat.title,
      message: 'Planned, but no scene realises it.',
      target: { table: 'beat', id: beat.id },
    });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return gaps.sort((a, b) => order[a.severity] - order[b.severity]
    || a.type.localeCompare(b.type)
    || a.entityName.localeCompare(b.entityName));
}

/** Counts for a badge, without making the caller group them itself. */
export function summariseGaps(gaps: Gap[]): Record<Severity, number> {
  return gaps.reduce(
    (acc, g) => ({ ...acc, [g.severity]: acc[g.severity] + 1 }),
    { error: 0, warning: 0, info: 0 } as Record<Severity, number>,
  );
}
