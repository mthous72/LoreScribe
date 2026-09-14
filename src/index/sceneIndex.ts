import type { SqlDriver } from '../db/driver';
import { detectMentions, type AliasEntry } from '../domain/mentions';
import { entityLinksFrom } from '../editor/entityLink';
import { uuidv7 } from '../data/ids';

/**
 * One scene's derived rows, brought up to date.
 *
 * Shared by the write path (a save re-indexes the scene it just wrote) and by
 * the wholesale rebuilder (which calls this once per scene). The alternative —
 * the repository marking `mention` and `fts` globally stale on every autosave —
 * would leave the settings panel permanently red and turn a rebuild into
 * something a writer has to do constantly. `index_state.stale` is for
 * *wholesale* invalidation: an import, a restore, an algorithm revision. Row-level
 * freshness is maintained here, incrementally, as the row is written.
 *
 * The delete guard lives in this one function, which is the point: a confirmed
 * mention, or one the prose placed explicitly, is authored evidence and must
 * survive both paths identically.
 */

export interface SceneIndexRow {
  id: string;
  title: string | null;
  contentText: string | null;
  /**
   * The stored document, read for the explicit `@` links in its marks.
   *
   * Taken from the row rather than handed in by the editor so the write path
   * and a wholesale rebuild see the same links. A rebuild that could not see
   * them would delete every one as stale on its first run.
   */
  contentJson?: string | null;
  globalRank: string | null;
  povEntityId: string | null;
}

/**
 * What this function owns, and its exact complement.
 *
 * Both `alias_match` and `explicit` rows are derived — the first from the
 * prose, the second from the document's marks — so both are rewritten here.
 * `explicit` used to be preserved unconditionally because nothing produced it;
 * now that `@` insert does, preserving it would mean a link survived the
 * deletion of the word it pointed at.
 *
 * A `confirmed` row is the writer's judgement and outlives any rebuild. So does
 * any other method: an `inferred` row will come from a model pass that cannot
 * be re-derived from the text, and clobbering it on the next keystroke would
 * throw away work that costs money to produce.
 *
 * `IFNULL` because a NULL `method` must fall on one side or the other rather
 * than both: a row the delete leaves behind and this query does not report is a
 * row the insert duplicates.
 */
const OWNED = 'IFNULL(method,\'\') IN (\'alias_match\',\'explicit\') AND confirmed = 0';
const KEPT = `SELECT entity_id FROM mention WHERE scene_id = ? AND NOT (${OWNED})`;
const DERIVED = `DELETE FROM mention WHERE scene_id = ? AND ${OWNED}`;

/**
 * Rewrite `mention` and `scene_fts` for one scene, in a single transaction.
 *
 * Returns how many rows the scene now has in `mention`, including the ones that
 * were kept — the same "coverage, not writes" meaning `index_state.built_rows`
 * uses everywhere else.
 */
export async function indexScene(
  driver: SqlDriver, scene: SceneIndexRow, aliases: readonly AliasEntry[],
): Promise<number> {
  // Read before writing, so the delete, the inserts and the FTS rewrite can all
  // go in one batch and a failure leaves the scene's old index intact.
  const { rows } = await driver.query(KEPT, [scene.id], 'all');
  const kept = new Set((rows as unknown[][]).map((r) => String(r[0])));

  const { mentions } = detectMentions(scene.contentText ?? '', aliases, {
    sceneRank: scene.globalRank,
    povEntityId: scene.povEntityId,
    explicitSpans: entityLinksFrom(scene.contentJson).map((link) => ({
      entityId: link.entityId,
      alias: link.text,
      start: link.start,
      end: link.end,
    })),
  });

  const now = Date.now();
  const fresh = mentions.filter((m) => !kept.has(m.entityId));

  await driver.batch([
    { sql: DERIVED, params: [scene.id] },
    ...fresh.map((m) => ({
      sql: `INSERT INTO mention (id,scene_id,entity_id,role,start_offset,end_offset,
              alias_used,method,confidence,confirmed,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
      params: [uuidv7(now), scene.id, m.entityId, m.role, m.startOffset, m.endOffset,
        m.aliasUsed, m.method, 1.0, now],
    })),
    ...sceneFtsStatements(scene),
  ], true);

  return fresh.length + kept.size;
}

/**
 * Delete-then-insert for one scene's FTS row.
 *
 * Exposed separately because it needs no alias list and no read, so the write
 * path can fold it into the transaction that saves the prose. FTS5 has no
 * upsert; a delete by the unindexed `scene_id` column is a scan, which at novel
 * scale is nothing.
 */
export function sceneFtsStatements(scene: SceneIndexRow): { sql: string; params: unknown[] }[] {
  return [
    { sql: 'DELETE FROM scene_fts WHERE scene_id = ?', params: [scene.id] },
    {
      sql: 'INSERT INTO scene_fts (scene_id, title, content_text) VALUES (?,?,?)',
      params: [scene.id, scene.title, scene.contentText],
    },
  ];
}

/** Every alias in a project, with spoiler scenes resolved to their rank. */
export async function loadAliases(driver: SqlDriver, projectId: string): Promise<AliasEntry[]> {
  const { rows } = await driver.query(
    // The matcher compares ranks, not ids: an alias that is itself a spoiler is
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
