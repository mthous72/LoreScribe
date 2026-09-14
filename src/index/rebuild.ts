import type { SqlDriver } from '../db/driver';
import { rankUpdates, IN_PROJECT } from './sceneRank';
import { indexScene, loadAliases, type SceneIndexRow } from './sceneIndex';
import { codexFtsRebuild } from './codexIndex';
import {
  DERIVED_KINDS, REVISIONS, indexStatus, markStale, recordBuild, recordFailure,
  type DerivedKind, type KindStatus,
} from './indexState';

/**
 * The rebuild path for every derived kind — doc 08 Phase 1, doc 02 §9b.
 *
 * Two rules hold for all four rebuilders, and both are about the same thing:
 * derived data lives in the same file as the novel, so a rebuild is one bad
 * `DELETE` away from destroying work.
 *
 *  1. **A rebuilder deletes only what it produced.** A `mention` the writer
 *     confirmed, or one placed explicitly by a link in the prose, is authored
 *     evidence and outlives any number of rebuilds. Only `method='alias_match'`
 *     rows that nobody has confirmed are the matcher's to replace.
 *  2. **A rebuild is restartable.** The kind is marked stale on the way in and
 *     cleared only on success, so a tab that dies halfway leaves a flag saying
 *     "this is half-built" rather than a table that looks finished.
 */

export interface RebuildProgress {
  kind: DerivedKind;
  done: number;
  total: number;
}

/**
 * `built_rows` means the same thing for every kind: how many rows this kind
 * now covers for the project, not how many were written. A rebuild of an
 * already-correct index writes nothing, and reporting zero there would read as
 * a failure rather than as "nothing had moved".
 */

export interface Rebuilder {
  kind: DerivedKind;
  label: string;
  /** What this kind is for, in the writer's terms, not the schema's. */
  describes: string;
  revision: number;
  /** Why it cannot run in this build, or null when it can. */
  unavailable: string | null;
  run(driver: SqlDriver, projectId: string, onProgress?: (p: RebuildProgress) => void): Promise<number>;
}

/* ------------------------------------------------------------------- ranks */

/**
 * `scene.global_rank` from the sort keys above each scene.
 *
 * Deliberately does NOT bump `rev` or write `op_log`. The rank is a function of
 * rows that were already logged when they changed, so logging it again would
 * fill the sync log with entries that carry no information and make every
 * rebuild look like the writer edited every scene.
 */
async function rebuildRanks(
  driver: SqlDriver, projectId: string, onProgress?: (p: RebuildProgress) => void,
): Promise<number> {
  const { updates, examined } = await rankUpdates(driver, IN_PROJECT, [projectId]);
  for (let i = 0; i < updates.length; i += 200) {
    await driver.batch(updates.slice(i, i + 200), true);
    onProgress?.({ kind: 'rank', done: Math.min(i + 200, updates.length), total: updates.length });
  }
  return examined;
}

/* --------------------------------------------------------------------- fts */

/**
 * Both FTS5 indexes, scoped to one project.
 *
 * Pure SQL: the rows never leave SQLite, so a 150,000-word project rebuilds
 * without marshalling a single string across the worker boundary.
 */
async function rebuildFts(driver: SqlDriver, projectId: string): Promise<number> {
  const projectScenes =
    `SELECT s.id FROM scene s JOIN chapter c ON c.id = s.chapter_id
     JOIN book b ON b.id = c.book_id WHERE b.project_id = ?`;

  await driver.batch([
    { sql: `DELETE FROM scene_fts WHERE scene_id IN (${projectScenes})`, params: [projectId] },
    {
      sql: `INSERT INTO scene_fts (scene_id, title, content_text)
            SELECT s.id, s.title, s.content_text FROM scene s
            JOIN chapter c ON c.id = s.chapter_id JOIN book b ON b.id = c.book_id
            WHERE b.project_id = ? AND s.deleted_at IS NULL`,
      params: [projectId],
    },
    {
      sql: `DELETE FROM codex_fts WHERE
              (owner_table = 'entity' AND owner_id IN (SELECT id FROM entity WHERE project_id = ?))
           OR (owner_table = 'fact'   AND owner_id IN (SELECT id FROM fact   WHERE project_id = ?))
           OR (owner_table = 'note'   AND owner_id IN (SELECT id FROM note   WHERE project_id = ?))`,
      params: [projectId, projectId, projectId],
    },
    // The same expressions the write path uses, from codexIndex.ts. Two
    // spellings of "what text represents an entity" would mean a rebuild
    // changed the data rather than restoring it.
    { sql: codexFtsRebuild('entity'), params: [projectId] },
    { sql: codexFtsRebuild('fact'), params: [projectId] },
    { sql: codexFtsRebuild('note'), params: [projectId] },
  ], true);

  const { rows } = await driver.query(
    `SELECT (SELECT COUNT(*) FROM scene_fts WHERE scene_id IN (${projectScenes}))
          + (SELECT COUNT(*) FROM codex_fts WHERE owner_table = 'entity'
             AND owner_id IN (SELECT id FROM entity WHERE project_id = ?))
          + (SELECT COUNT(*) FROM codex_fts WHERE owner_table = 'fact'
             AND owner_id IN (SELECT id FROM fact WHERE project_id = ?))
          + (SELECT COUNT(*) FROM codex_fts WHERE owner_table = 'note'
             AND owner_id IN (SELECT id FROM note WHERE project_id = ?))`,
    [projectId, projectId, projectId, projectId], 'get');
  return Number((rows as unknown[])[0] ?? 0);
}

/* ---------------------------------------------------------------- mentions */

async function rebuildMentions(
  driver: SqlDriver, projectId: string, onProgress?: (p: RebuildProgress) => void,
): Promise<number> {
  const aliases = await loadAliases(driver, projectId);
  const { rows } = await driver.query(
    `SELECT s.id, s.title, s.content_text, s.global_rank, s.pov_entity_id
     FROM scene s JOIN chapter c ON c.id = s.chapter_id JOIN book b ON b.id = c.book_id
     WHERE b.project_id = ? AND s.deleted_at IS NULL
     ORDER BY s.global_rank`, [projectId], 'all');
  const scenes = (rows as unknown[][]).map((r): SceneIndexRow => ({
    id: r[0] as string,
    title: r[1] as string | null,
    contentText: r[2] as string | null,
    globalRank: r[3] as string | null,
    povEntityId: r[4] as string | null,
  }));

  // One scene at a time, through the same function the write path uses. A
  // rebuild that applied different rules to the same rows would be a rebuild
  // that changes the data rather than restoring it.
  let covered = 0;
  for (let i = 0; i < scenes.length; i++) {
    covered += await indexScene(driver, scenes[i]!, aliases);
    onProgress?.({ kind: 'mention', done: i + 1, total: scenes.length });
  }
  return covered;
}

/* -------------------------------------------------------------- embeddings */

export const REBUILDERS: Rebuilder[] = [
  {
    kind: 'rank', label: 'Manuscript order', revision: REVISIONS.rank,
    describes: 'where each scene sits in the whole book, used by every list and every spoiler check',
    unavailable: null, run: rebuildRanks,
  },
  {
    kind: 'mention', label: 'Who appears where', revision: REVISIONS.mention,
    describes: 'the characters, places and things each scene mentions, found by matching your alias list',
    unavailable: null, run: rebuildMentions,
  },
  {
    kind: 'fts', label: 'Search index', revision: REVISIONS.fts,
    describes: 'full-text search across your scenes, codex and notes',
    unavailable: null, run: (driver, projectId) => rebuildFts(driver, projectId),
  },
  {
    kind: 'embedding', label: 'Semantic search', revision: REVISIONS.embedding,
    // Saying this plainly beats a button that succeeds instantly and builds
    // nothing: the whole value of index_state is that it does not lie about
    // what is in the tables.
    describes: 'meaning-based search, which needs an embedding model to build',
    unavailable: 'No embedding model is bundled yet — this arrives with the AI features in Phase 3.',
    run: async () => 0,
  },
];

export function rebuilderFor(kind: DerivedKind): Rebuilder {
  const found = REBUILDERS.find((r) => r.kind === kind);
  if (!found) throw new Error(`no rebuilder for ${kind}`);
  return found;
}

export interface RebuildOutcome {
  kind: DerivedKind;
  rows: number;
  ms: number;
  error: string | null;
  skipped: string | null;
}

/**
 * Rebuild one kind, honestly.
 *
 * Stale first, build, clear — and on a throw the kind stays stale with the
 * message attached, so the next session finds a flag rather than a table that
 * looks finished and is not.
 */
export async function rebuildKind(
  driver: SqlDriver, projectId: string, kind: DerivedKind,
  onProgress?: (p: RebuildProgress) => void,
): Promise<RebuildOutcome> {
  const rebuilder = rebuilderFor(kind);
  if (rebuilder.unavailable) {
    return { kind, rows: 0, ms: 0, error: null, skipped: rebuilder.unavailable };
  }
  const started = Date.now();
  await markStale(driver, [kind]);
  try {
    const rows = await rebuilder.run(driver, projectId, onProgress);
    await recordBuild(driver, kind, rows);
    return { kind, rows, ms: Date.now() - started, error: null, skipped: null };
  } catch (e) {
    await recordFailure(driver, kind, e);
    return {
      kind, rows: 0, ms: Date.now() - started,
      error: (e as { message?: string })?.message ?? String(e), skipped: null,
    };
  }
}

/**
 * Rebuild everything, in dependency order.
 *
 * `rank` runs first and the order in DERIVED_KINDS is not cosmetic: mention
 * detection asks whether a spoiler alias is linkable *at this scene's rank*,
 * so rebuilding mentions against ranks that are themselves stale would hide
 * some links and reveal others.
 */
export async function rebuildAll(
  driver: SqlDriver, projectId: string,
  kinds: readonly DerivedKind[] = DERIVED_KINDS,
  onProgress?: (p: RebuildProgress) => void,
): Promise<RebuildOutcome[]> {
  const out: RebuildOutcome[] = [];
  for (const kind of DERIVED_KINDS.filter((k) => kinds.includes(k))) {
    out.push(await rebuildKind(driver, projectId, kind, onProgress));
  }
  return out;
}

/** Everything the settings panel needs to decide what to offer. */
export async function rebuildPlan(driver: SqlDriver): Promise<(KindStatus & Rebuilder)[]> {
  const status = await indexStatus(driver);
  return status.map((s) => ({
    ...s, ...rebuilderFor(s.kind), needsRebuild: s.needsRebuild, reason: s.reason,
  }));
}
