import type { SqlDriver } from '../db/driver';
import { sceneGlobalRank } from '../domain/sortKey';
import { detectMentions, type AliasEntry } from '../domain/mentions';
import { uuidv7 } from '../data/ids';
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
  const { rows } = await driver.query(
    `SELECT s.id, b.sort_key, p.sort_key, c.sort_key, s.sort_key, s.global_rank
     FROM scene s
     JOIN chapter c ON c.id = s.chapter_id
     JOIN book b    ON b.id = c.book_id
     LEFT JOIN part p ON p.id = c.part_id
     WHERE b.project_id = ?`, [projectId], 'all');

  const writes: { sql: string; params: unknown[] }[] = [];
  for (const r of rows as unknown[][]) {
    const rank = sceneGlobalRank({
      bookKey: String(r[1] ?? ''),
      partKey: r[2] as string | null,
      chapterKey: String(r[3] ?? ''),
      sceneKey: String(r[4] ?? ''),
    });
    // Only the rows that actually move. A rebuild of an already-correct index
    // should be close to free, or nobody will press the button.
    if (rank !== r[5]) writes.push({ sql: 'UPDATE scene SET global_rank = ? WHERE id = ?', params: [rank, r[0]] });
  }
  for (let i = 0; i < writes.length; i += 200) {
    await driver.batch(writes.slice(i, i + 200), true);
    onProgress?.({ kind: 'rank', done: Math.min(i + 200, writes.length), total: writes.length });
  }
  return (rows as unknown[][]).length;
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
    {
      sql: `INSERT INTO codex_fts (owner_table, owner_id, name, body)
            SELECT 'entity', id, name, COALESCE(summary,'') || ' ' || COALESCE(description,'')
            FROM entity WHERE project_id = ? AND deleted_at IS NULL`,
      params: [projectId],
    },
    {
      sql: `INSERT INTO codex_fts (owner_table, owner_id, name, body)
            SELECT 'fact', id, predicate, statement
            FROM fact WHERE project_id = ? AND deleted_at IS NULL`,
      params: [projectId],
    },
    {
      sql: `INSERT INTO codex_fts (owner_table, owner_id, name, body)
            SELECT 'note', id, COALESCE(title,''), COALESCE(body,'')
            FROM note WHERE project_id = ? AND deleted_at IS NULL`,
      params: [projectId],
    },
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

async function loadAliases(driver: SqlDriver, projectId: string): Promise<AliasEntry[]> {
  const { rows } = await driver.query(
    // linkable_from_scene_id is resolved to that scene's rank here, because the
    // matcher compares ranks, not ids — an alias that is itself a spoiler is
    // linkable from a position in the book, not from a particular row.
    `SELECT a.entity_id, a.alias, a.auto_link, s.global_rank
     FROM entity_alias a
     JOIN entity e ON e.id = a.entity_id
     LEFT JOIN scene s ON s.id = a.linkable_from_scene_id
     WHERE e.project_id = ? AND e.deleted_at IS NULL`, [projectId], 'all');
  return (rows as unknown[][]).map((r) => ({
    entityId: r[0] as string,
    alias: r[1] as string,
    autoLink: Number(r[2]) !== 0,
    linkableFromRank: (r[3] as string | null) ?? null,
  }));
}

async function rebuildMentions(
  driver: SqlDriver, projectId: string, onProgress?: (p: RebuildProgress) => void,
): Promise<number> {
  const aliases = await loadAliases(driver, projectId);
  const { rows: sceneRows } = await driver.query(
    `SELECT s.id, s.content_text, s.pov_entity_id, s.global_rank
     FROM scene s JOIN chapter c ON c.id = s.chapter_id JOIN book b ON b.id = c.book_id
     WHERE b.project_id = ? AND s.deleted_at IS NULL
     ORDER BY s.global_rank`, [projectId], 'all');
  const scenes = sceneRows as unknown[][];

  let covered = 0;
  for (let i = 0; i < scenes.length; i++) {
    const [sceneId, text, povEntityId, rank] =
      scenes[i] as [string, string | null, string | null, string | null];

    // Rule 1: only the matcher's own unconfirmed rows go. A confirmed mention
    // is the writer's judgement and an explicit one came from the prose itself.
    await driver.query(
      'DELETE FROM mention WHERE scene_id = ? AND method = \'alias_match\' AND confirmed = 0',
      [sceneId], 'run');

    const { rows: keptRows } = await driver.query(
      'SELECT entity_id FROM mention WHERE scene_id = ?', [sceneId], 'all');
    const kept = new Set((keptRows as unknown[][]).map((r) => String(r[0])));

    const { mentions } = detectMentions(text ?? '', aliases, {
      sceneRank: rank, povEntityId,
    });

    const now = Date.now();
    const inserts = mentions
      .filter((m) => !kept.has(m.entityId))
      .map((m) => ({
        sql: `INSERT INTO mention (id,scene_id,entity_id,role,start_offset,end_offset,
                alias_used,method,confidence,confirmed,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
        params: [uuidv7(now), sceneId, m.entityId, m.role, m.startOffset, m.endOffset,
          m.aliasUsed, m.method, 1.0, now],
      }));
    if (inserts.length) await driver.batch(inserts, true);
    covered += inserts.length + kept.size;
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
