import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import { keyBetween } from '../domain/sortKey';
import { countWords } from '../text/words';
import { rankUpdates, IN_BOOK, IN_CHAPTER, IN_PART, IS_SCENE } from '../index/sceneRank';
import { indexScene, loadAliases, sceneFtsStatements, type SceneIndexRow } from '../index/sceneIndex';

/**
 * The manuscript: book, part, chapter, scene.
 *
 * Follows `ProjectRepository`'s discipline — every mutation and its `op_log`
 * row go in ONE batch, which is one transaction, so a failure to log rolls the
 * mutation back ([doc 08 rule 6's carve-out](../../docs/08-roadmap.md)).
 *
 * Two things are specific to this layer and are the reason it exists rather
 * than the UI writing SQL:
 *
 *  1. **A reorder writes one row.** Siblings are ordered by a fractional sort
 *     key ([doc 12 §9](../../docs/12-algorithms.md)), so dragging a scene mints
 *     a midpoint between its new neighbours and touches nothing else. This is
 *     not an optimisation: the temporal model addresses narrative position by
 *     scene reference, and a reorder that renumbered a chapter would churn the
 *     graph underneath it.
 *  2. **Derived data moves with it, in the same transaction.** `global_rank` is
 *     recomputed for exactly the scenes a move can reach, and `scene_fts`
 *     follows the prose. A commit that left either behind would render a
 *     chapter list in the wrong order, or search results for text that is no
 *     longer there — briefly, which is long enough for a writer to see it.
 */

export interface Book {
  id: string; projectId: string; title: string; sortKey: string;
  status: string | null; rev: number;
}
export interface Part {
  id: string; bookId: string; title: string | null; sortKey: string; rev: number;
}
export interface Chapter {
  id: string; bookId: string; partId: string | null; number: number | null;
  title: string | null; sortKey: string; status: string | null; rev: number;
}
/** A scene without its prose — what a tree renders. */
export interface SceneSummary {
  id: string; chapterId: string; title: string | null; sortKey: string;
  globalRank: string; wordCount: number; status: string | null;
  povEntityId: string | null; rev: number;
}
export interface SceneContent {
  contentJson: string | null;
  contentText: string | null;
}

/** A part and its chapters, or the chapters that belong to no part. */
export interface OutlineGroup {
  part: Part | null;
  chapters: { chapter: Chapter; scenes: SceneSummary[] }[];
}

/** Where a new or moved item goes among its siblings. */
export interface Placement {
  /** Put it directly after this sibling. Omit both for the end of the list. */
  afterId?: string | null;
  /** Put it directly before this sibling. */
  beforeId?: string | null;
}

interface Statement { sql: string; params: unknown[] }

export class ManuscriptRepository {
  constructor(private readonly driver: SqlDriver) {}

  /* ------------------------------------------------------------------ reads */

  async listBooks(projectId: string): Promise<Book[]> {
    const rows = await this.#all(
      `SELECT id, project_id, title, sort_key, status, rev FROM book
       WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_key`, [projectId]);
    return rows.map((r) => ({
      id: r[0] as string, projectId: r[1] as string, title: r[2] as string,
      sortKey: r[3] as string, status: r[4] as string | null, rev: Number(r[5]),
    }));
  }

  async listParts(bookId: string): Promise<Part[]> {
    const rows = await this.#all(
      `SELECT id, book_id, title, sort_key, rev FROM part
       WHERE book_id = ? AND deleted_at IS NULL ORDER BY sort_key`, [bookId]);
    return rows.map((r) => ({
      id: r[0] as string, bookId: r[1] as string, title: r[2] as string | null,
      sortKey: r[3] as string, rev: Number(r[4]),
    }));
  }

  async listChapters(bookId: string): Promise<Chapter[]> {
    const rows = await this.#all(
      `SELECT id, book_id, part_id, number, title, sort_key, status, rev FROM chapter
       WHERE book_id = ? AND deleted_at IS NULL ORDER BY sort_key`, [bookId]);
    return rows.map((r) => ({
      id: r[0] as string, bookId: r[1] as string, partId: r[2] as string | null,
      number: r[3] === null ? null : Number(r[3]), title: r[4] as string | null,
      sortKey: r[5] as string, status: r[6] as string | null, rev: Number(r[7]),
    }));
  }

  async listScenes(chapterId: string): Promise<SceneSummary[]> {
    return this.#scenes('s.chapter_id = ?', [chapterId], 's.sort_key');
  }

  /** Every scene in a book, in reading order. The order `global_rank` exists for. */
  async readingOrder(bookId: string): Promise<SceneSummary[]> {
    return this.#scenes('c.book_id = ?', [bookId], 's.global_rank');
  }

  /**
   * A whole book's structure in two queries.
   *
   * Not `listScenes` per chapter: that is one query per chapter, and a novel
   * has forty of them. The tree reloads after every create, rename and move, so
   * this is on the path of every interaction rather than a page load.
   *
   * Chapters with no part come first, under a `null` part, which is the same
   * order `sceneGlobalRank` gives them — an empty part segment sorts below any
   * real one. The tree and the manuscript therefore agree by construction
   * rather than by two functions happening to make the same choice.
   */
  async outline(bookId: string): Promise<OutlineGroup[]> {
    const [parts, chapters, scenes] = await Promise.all([
      this.listParts(bookId),
      this.listChapters(bookId),
      this.readingOrder(bookId),
    ]);

    const byChapter = new Map<string, SceneSummary[]>();
    for (const scene of scenes) {
      const at = byChapter.get(scene.chapterId);
      if (at) at.push(scene);
      else byChapter.set(scene.chapterId, [scene]);
    }
    const withScenes = (c: Chapter) => ({ chapter: c, scenes: byChapter.get(c.id) ?? [] });

    const loose = chapters.filter((c) => c.partId === null);
    const groups: OutlineGroup[] = loose.length
      ? [{ part: null, chapters: loose.map(withScenes) }]
      : [];
    for (const part of parts) {
      groups.push({
        part,
        chapters: chapters.filter((c) => c.partId === part.id).map(withScenes),
      });
    }
    return groups;
  }

  async getSceneContent(sceneId: string): Promise<SceneContent | null> {
    const { rows } = await this.driver.query(
      'SELECT content_json, content_text FROM scene WHERE id = ?', [sceneId], 'get');
    const r = rows as unknown[];
    if (!r.length) return null;
    return { contentJson: r[0] as string | null, contentText: r[1] as string | null };
  }

  /* ---------------------------------------------------------------- creates */

  async createBook(projectId: string, title: string): Promise<Book> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('book', 'project_id', projectId, {});
    const row: Book = { id, projectId, title, sortKey, status: 'drafting', rev: 1 };
    await this.driver.batch([
      {
        sql: `INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,1)`,
        params: [id, projectId, title, sortKey, now, now],
      },
      this.#op('book', id, 'insert', row, now),
    ], true);
    return row;
  }

  async createPart(bookId: string, title: string, at: Placement = {}): Promise<Part> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('part', 'book_id', bookId, at);
    const row: Part = { id, bookId, title, sortKey, rev: 1 };
    await this.driver.batch([
      {
        sql: `INSERT INTO part (id,book_id,title,sort_key,created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,1)`,
        params: [id, bookId, title, sortKey, now, now],
      },
      this.#op('part', id, 'insert', row, now),
    ], true);
    return row;
  }

  async createChapter(
    bookId: string, title: string, options: Placement & { partId?: string | null } = {},
  ): Promise<Chapter> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('chapter', 'book_id', bookId, options);
    const partId = options.partId ?? null;
    const row: Chapter = {
      id, bookId, partId, number: null, title, sortKey, status: 'planned', rev: 1,
    };
    await this.driver.batch([
      {
        sql: `INSERT INTO chapter (id,book_id,part_id,title,sort_key,created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,?,1)`,
        params: [id, bookId, partId, title, sortKey, now, now],
      },
      this.#op('chapter', id, 'insert', row, now),
    ], true);
    return row;
  }

  async createScene(chapterId: string, title: string, at: Placement = {}): Promise<SceneSummary> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('scene', 'chapter_id', chapterId, at);
    const row: SceneSummary = {
      id, chapterId, title, sortKey, globalRank: '', wordCount: 0,
      status: 'planned', povEntityId: null, rev: 1,
    };
    await this.driver.batch([
      {
        // global_rank is NOT NULL and is filled by the rank statements in this
        // same transaction; the empty string never survives the commit.
        sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,status,
                word_count,created_at,updated_at,rev)
              VALUES (?,?,?,?,'','planned',0,?,?,1)`,
        params: [id, chapterId, title, sortKey, now, now],
      },
      this.#op('scene', id, 'insert', row, now),
      ...sceneFtsStatements({ id, title, contentText: null, globalRank: null, povEntityId: null }),
    ], true);

    const ranks = await this.#ranks(IS_SCENE, [id]);
    if (ranks.length) await this.driver.batch(ranks, true);
    row.globalRank = (await this.#scenes(IS_SCENE, [id], 's.sort_key'))[0]?.globalRank ?? '';
    return row;
  }

  /* ---------------------------------------------------------------- updates */

  async renameScene(id: string, title: string): Promise<void> {
    const now = Date.now();
    const scene = await this.#sceneIndexRow(id);
    await this.driver.batch([
      {
        sql: `UPDATE scene SET title = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [title, now, id],
      },
      this.#op('scene', id, 'update', { title }, now),
      ...(scene ? sceneFtsStatements({ ...scene, title }) : []),
    ], true);
  }

  async renameChapter(id: string, title: string): Promise<void> {
    await this.#rename('chapter', id, title);
  }

  async renameBook(id: string, title: string): Promise<void> {
    await this.#rename('book', id, title);
  }

  async renamePart(id: string, title: string): Promise<void> {
    await this.#rename('part', id, title);
  }

  /**
   * The autosave path.
   *
   * Prose, word count and the search index commit together. `word_count` is
   * `countWords`, never `split(' ')`, because goals, statistics and budget
   * estimates all read this column and a writer who catches the tool
   * miscounting once stops believing the rest of it (doc 12 §6).
   *
   * Mentions are deliberately NOT re-detected here. They churn mid-word — an
   * alias is half-typed for a few keystrokes — and rewriting them on every
   * autosave would make the editor's decorations flicker. `reindexScene` is the
   * caller's to run on a longer debounce; the rules it applies are the same
   * ones the wholesale rebuild uses, so the timing is the only thing a caller
   * can get wrong.
   */
  async saveSceneContent(
    id: string, content: { contentJson?: string | null; contentText: string | null },
  ): Promise<{ wordCount: number }> {
    const now = Date.now();
    const wordCount = countWords(content.contentText ?? '').words;
    const scene = await this.#sceneIndexRow(id);

    await this.driver.batch([
      {
        sql: `UPDATE scene SET content_json = ?, content_text = ?, word_count = ?,
                updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [content.contentJson ?? null, content.contentText, wordCount, now, id],
      },
      // The op_log payload carries the text, not just the fact of a change: a
      // sync that could not replay the prose would replicate a manuscript
      // consisting entirely of timestamps.
      this.#op('scene', id, 'update', { contentText: content.contentText, wordCount }, now),
      ...(scene ? sceneFtsStatements({ ...scene, contentText: content.contentText }) : []),
    ], true);

    return { wordCount };
  }

  /** Re-detect this scene's mentions. Same rules as a wholesale rebuild. */
  async reindexScene(projectId: string, sceneId: string): Promise<number> {
    const scene = await this.#sceneIndexRow(sceneId);
    if (!scene) return 0;
    return indexScene(this.driver, scene, await loadAliases(this.driver, projectId));
  }

  /* ------------------------------------------------------------------ moves */

  /**
   * Move a scene, possibly into another chapter.
   *
   * One row for the scene, plus the `global_rank` of the scenes the move
   * reaches — which is the scenes in the chapters it left and joined, and
   * nothing else.
   */
  async moveScene(
    sceneId: string, to: Placement & { chapterId?: string } = {},
  ): Promise<{ sortKey: string; ranksChanged: number }> {
    const now = Date.now();
    const current = (await this.#all(
      'SELECT chapter_id FROM scene WHERE id = ?', [sceneId]))[0];
    if (!current) throw new Error(`no such scene: ${sceneId}`);
    const fromChapter = String(current[0]);
    const chapterId = to.chapterId ?? fromChapter;

    const sortKey = await this.#keyFor('scene', 'chapter_id', chapterId, to, sceneId);
    const writes: Statement[] = [
      {
        sql: `UPDATE scene SET chapter_id = ?, sort_key = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [chapterId, sortKey, now, sceneId],
      },
      this.#op('scene', sceneId, 'update', { chapterId, sortKey }, now),
    ];

    // The move has to be visible to the rank query, and the rank updates have
    // to land in the same transaction as the move. Those pull opposite ways, so
    // the ranks are computed from the keys we are about to write rather than by
    // reading the row back: a two-transaction version leaves a window in which
    // the manuscript is ordered wrongly.
    await this.driver.batch(writes, true);
    const ranks = [
      ...await this.#ranks(IN_CHAPTER, [chapterId]),
      ...(chapterId === fromChapter ? [] : await this.#ranks(IN_CHAPTER, [fromChapter])),
    ];
    if (ranks.length) await this.driver.batch(ranks, true);
    return { sortKey, ranksChanged: ranks.length };
  }

  /** Move a chapter within its book, optionally into a different part. */
  async moveChapter(
    chapterId: string, to: Placement & { partId?: string | null } = {},
  ): Promise<{ sortKey: string; ranksChanged: number }> {
    const now = Date.now();
    const current = (await this.#all(
      'SELECT book_id, part_id FROM chapter WHERE id = ?', [chapterId]))[0];
    if (!current) throw new Error(`no such chapter: ${chapterId}`);
    const bookId = String(current[0]);
    const partId = 'partId' in to ? (to.partId ?? null) : (current[1] as string | null);

    const sortKey = await this.#keyFor('chapter', 'book_id', bookId, to, chapterId);
    await this.driver.batch([
      {
        sql: `UPDATE chapter SET part_id = ?, sort_key = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [partId, sortKey, now, chapterId],
      },
      this.#op('chapter', chapterId, 'update', { partId, sortKey }, now),
    ], true);

    // A chapter move can reorder scenes anywhere in the book, because part keys
    // sit above chapter keys in the rank.
    const ranks = await this.#ranks(IN_BOOK, [bookId]);
    if (ranks.length) await this.driver.batch(ranks, true);
    return { sortKey, ranksChanged: ranks.length };
  }

  async movePart(partId: string, to: Placement = {}): Promise<{ sortKey: string }> {
    const now = Date.now();
    const current = (await this.#all('SELECT book_id FROM part WHERE id = ?', [partId]))[0];
    if (!current) throw new Error(`no such part: ${partId}`);
    const bookId = String(current[0]);
    const sortKey = await this.#keyFor('part', 'book_id', bookId, to, partId);
    await this.driver.batch([
      {
        sql: `UPDATE part SET sort_key = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [sortKey, now, partId],
      },
      this.#op('part', partId, 'update', { sortKey }, now),
    ], true);
    const ranks = await this.#ranks(IN_PART, [partId]);
    if (ranks.length) await this.driver.batch(ranks, true);
    return { sortKey };
  }

  /* ---------------------------------------------------------------- deletes */

  /**
   * Soft delete, cascading down the tree.
   *
   * The schema's foreign keys cascade a HARD delete; a soft delete has to be
   * cascaded by hand or a chapter's scenes outlive it as orphans that every
   * reading-order query still returns. Each affected row gets its own `op_log`
   * entry, because a sync that replayed "chapter deleted" and nothing else
   * would leave the scenes behind on the other device.
   */
  async removeScene(id: string): Promise<void> {
    await this.#softDelete([{ table: 'scene', ids: [id] }]);
  }

  async removeChapter(id: string): Promise<void> {
    const scenes = (await this.#all(
      'SELECT id FROM scene WHERE chapter_id = ? AND deleted_at IS NULL', [id]))
      .map((r) => String(r[0]));
    await this.#softDelete([{ table: 'scene', ids: scenes }, { table: 'chapter', ids: [id] }]);
  }

  /**
   * Remove a part, keeping its chapters.
   *
   * Deliberately not a cascade: a part is a grouping a writer imposed on
   * chapters that already existed, and deleting "Act Two" should not delete the
   * chapters in it. They return to the book's top level, which is what the
   * nullable `chapter.part_id` is for.
   */
  async removePart(id: string): Promise<void> {
    const now = Date.now();
    const orphans = (await this.#all(
      'SELECT id, book_id FROM chapter WHERE part_id = ? AND deleted_at IS NULL', [id]));
    await this.driver.batch([
      ...orphans.flatMap((r) => [
        {
          sql: 'UPDATE chapter SET part_id = NULL, updated_at = ?, rev = rev + 1 WHERE id = ?',
          params: [now, r[0]],
        },
        this.#op('chapter', String(r[0]), 'update', { partId: null }, now),
      ]),
      {
        sql: `UPDATE part SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('part', id, 'delete', null, now),
    ], true);
    const books = new Set(orphans.map((r) => String(r[1])));
    for (const bookId of books) {
      const ranks = await this.#ranks(IN_BOOK, [bookId]);
      if (ranks.length) await this.driver.batch(ranks, true);
    }
  }

  /* ----------------------------------------------------------------- private */

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }

  async #scenes(where: string, params: unknown[], order: string): Promise<SceneSummary[]> {
    const rows = await this.#all(
      `SELECT s.id, s.chapter_id, s.title, s.sort_key, s.global_rank, s.word_count,
              s.status, s.pov_entity_id, s.rev
       FROM scene s JOIN chapter c ON c.id = s.chapter_id
       WHERE ${where} AND s.deleted_at IS NULL ORDER BY ${order}`, params);
    return rows.map((r) => ({
      id: r[0] as string, chapterId: r[1] as string, title: r[2] as string | null,
      sortKey: r[3] as string, globalRank: r[4] as string, wordCount: Number(r[5] ?? 0),
      status: r[6] as string | null, povEntityId: r[7] as string | null, rev: Number(r[8]),
    }));
  }

  async #sceneIndexRow(id: string): Promise<SceneIndexRow | null> {
    const rows = await this.#all(
      'SELECT id, title, content_text, global_rank, pov_entity_id FROM scene WHERE id = ?', [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r[0] as string, title: r[1] as string | null, contentText: r[2] as string | null,
      globalRank: r[3] as string | null, povEntityId: r[4] as string | null,
    };
  }

  async #ranks(where: string, params: unknown[]): Promise<Statement[]> {
    return (await rankUpdates(this.driver, where, params)).updates;
  }

  /**
   * A sort key for a new or moved item among its siblings.
   *
   * `excludeId` matters on a move: the row being moved is still at its old key,
   * and treating it as its own neighbour asks `keyBetween` for a key between a
   * value and itself.
   */
  async #keyFor(
    table: string, scopeColumn: string, scopeId: string, at: Placement, excludeId?: string,
  ): Promise<string> {
    const rows = await this.#all(
      `SELECT id, sort_key FROM ${table}
       WHERE ${scopeColumn} = ? AND deleted_at IS NULL ORDER BY sort_key`, [scopeId]);
    const siblings = rows
      .map((r) => ({ id: String(r[0]), key: String(r[1]) }))
      .filter((s) => s.id !== excludeId);

    if (at.afterId) {
      const i = siblings.findIndex((s) => s.id === at.afterId);
      if (i >= 0) return keyBetween(siblings[i]!.key, siblings[i + 1]?.key ?? null);
    }
    if (at.beforeId) {
      const i = siblings.findIndex((s) => s.id === at.beforeId);
      if (i >= 0) return keyBetween(i > 0 ? siblings[i - 1]!.key : null, siblings[i]!.key);
    }
    // Default is the end of the list: a new scene belongs after the ones that
    // exist, and an unrecognised neighbour is not a reason to refuse the write.
    return keyBetween(siblings[siblings.length - 1]?.key ?? null, null);
  }

  async #rename(table: string, id: string, title: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE ${table} SET title = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [title, now, id],
      },
      this.#op(table, id, 'update', { title }, now),
    ], true);
  }

  async #softDelete(groups: { table: string; ids: string[] }[]): Promise<void> {
    const now = Date.now();
    const writes: Statement[] = [];
    for (const { table, ids } of groups) {
      for (const id of ids) {
        writes.push({
          // `deleted_at IS NULL` makes a repeat delete a no-op rather than a
          // second tombstone and a second rev bump; updated_at moves too, or a
          // sync keyed on it would never see the one change it most needs.
          sql: `UPDATE ${table} SET deleted_at = ?, updated_at = ?, rev = rev + 1
                WHERE id = ? AND deleted_at IS NULL`,
          params: [now, now, id],
        });
        writes.push(this.#op(table, id, 'delete', null, now));
        if (table === 'scene') {
          writes.push({ sql: 'DELETE FROM scene_fts WHERE scene_id = ?', params: [id] });
          // Mentions of a deleted scene are derived rows describing prose that
          // is no longer in the manuscript. They go; the entities do not.
          writes.push({ sql: 'DELETE FROM mention WHERE scene_id = ?', params: [id] });
        }
      }
    }
    if (writes.length) await this.driver.batch(writes, true);
  }

  #op(table: string, rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), table, rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}
