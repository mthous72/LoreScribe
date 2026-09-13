import type { SqlDriver } from '../db/driver';
import { sceneGlobalRank } from '../domain/sortKey';

/**
 * `scene.global_rank`, recomputed for whatever just moved.
 *
 * Shared by the write path and the rebuilder on purpose. The rank is composed
 * from four sort keys by one function ([sceneGlobalRank](../domain/sortKey.ts))
 * and it is selected by one query here, because the last time this repository
 * had two implementations of one derived value they disagreed and the symptom
 * would have been a silently reordered manuscript.
 *
 * Returns statements rather than executing them, so a caller can put them in
 * the same transaction as the move that made them necessary. A move that
 * committed without its ranks would leave the manuscript briefly out of order,
 * and "briefly" is long enough to render a chapter list wrong.
 */
const SOURCES = `
  SELECT s.id, b.sort_key, p.sort_key, c.sort_key, s.sort_key, s.global_rank
  FROM scene s
  JOIN chapter c ON c.id = s.chapter_id
  JOIN book b    ON b.id = c.book_id
  LEFT JOIN part p ON p.id = c.part_id`;

export interface RankUpdate { sql: string; params: unknown[] }

/**
 * Statements for every scene matching `where` whose rank is not already right.
 *
 * Only the rows that actually move: a rebuild of an already-correct index
 * should be close to free, and a reorder should write the scenes it reordered
 * rather than every scene in the book.
 */
export async function rankUpdates(
  driver: SqlDriver, where: string, params: unknown[],
): Promise<{ updates: RankUpdate[]; examined: number }> {
  const { rows } = await driver.query(`${SOURCES} WHERE ${where}`, params, 'all');
  const updates: RankUpdate[] = [];
  for (const r of rows as unknown[][]) {
    const rank = sceneGlobalRank({
      bookKey: String(r[1] ?? ''),
      partKey: r[2] as string | null,
      chapterKey: String(r[3] ?? ''),
      sceneKey: String(r[4] ?? ''),
    });
    // Deliberately no `rev` bump and no op_log row: the rank is a function of
    // rows that were already logged when they changed, so logging it again
    // would make every reorder look like the writer edited every scene.
    if (rank !== r[5]) {
      updates.push({ sql: 'UPDATE scene SET global_rank = ? WHERE id = ?', params: [rank, r[0]] });
    }
  }
  return { updates, examined: (rows as unknown[][]).length };
}

/** Every scene in a project. */
export const IN_PROJECT = 'b.project_id = ?';
/** Every scene in one book — what a part or chapter move can reach. */
export const IN_BOOK = 'b.id = ?';
/** Every scene under one part. */
export const IN_PART = 'c.part_id = ?';
/** Every scene in one chapter. */
export const IN_CHAPTER = 's.chapter_id = ?';
/** One scene. */
export const IS_SCENE = 's.id = ?';
