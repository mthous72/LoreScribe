import type { SqlDriver } from '../db/driver';
import {
  ftsQuery, parseSnippet, SNIPPET_OPEN, SNIPPET_CLOSE, type SnippetRun,
} from './searchQuery';

/**
 * Search across the manuscript and the codex.
 *
 * The indexes have existed and been maintained on every save since the rebuild
 * path landed; this is the first thing that reads them. Nothing here builds an
 * index or decides what goes in one — `src/index/sceneIndex.ts` does that, on
 * the write path, and `src/index/rebuild.ts` does it wholesale. A search that
 * maintained its own copy would be a second answer to "what does this book
 * say", and two answers is one too many.
 *
 * Ranking is FTS5's `bm25`, weighted so a hit in a title or a name outranks one
 * in the body. That is not a tuning preference: a writer searching "warden" who
 * has a character called The Warden means the character, and burying them under
 * forty scenes that mention the word is the search being wrong.
 */

export type SearchKind = 'scene' | 'entity' | 'fact' | 'note';

export interface SearchHit {
  kind: SearchKind;
  /** The row to open: a scene id, or an entity/fact/note id. */
  id: string;
  title: string;
  /** Where it sits — a chapter name, or what kind of codex entry this is. */
  context: string | null;
  snippet: SnippetRun[];
  /** bm25: lower is better. Kept so callers can merge two result sets. */
  score: number;
}

export interface SearchResults {
  hits: SearchHit[];
  /** What was actually sent to FTS5, for the diagnostics page. */
  expression: string | null;
  truncated: boolean;
}

const LIMIT = 40;
const SNIPPET_TOKENS = 12;

/**
 * Column weights, one per FTS5 column including the UNINDEXED ones.
 *
 * `bm25()` requires a weight for every column or it raises; the unindexed
 * key columns take 0 because a match can never land in them.
 */
const SCENE_RANK = 'bm25(scene_fts, 0.0, 10.0, 1.0)';
const CODEX_RANK = 'bm25(codex_fts, 0.0, 0.0, 10.0, 1.0)';

export class SearchRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * @param prefix match the final word as a prefix — on while the writer is
   * still typing, off for a submitted search.
   */
  async search(
    projectId: string, input: string, { prefix = true } = {},
  ): Promise<SearchResults> {
    const expression = ftsQuery(input, { prefix });
    if (!expression) return { hits: [], expression: null, truncated: false };

    const [scenes, codex] = await Promise.all([
      this.#scenes(projectId, expression),
      this.#codex(projectId, expression),
    ]);

    // One ranked list rather than two sections: a writer looking for a name
    // does not know in advance whether the best answer is a scene or an entry,
    // and making them scan two lists to find out is the app's problem showing.
    const hits = [...scenes, ...codex].sort((a, b) => a.score - b.score);
    return {
      expression,
      truncated: hits.length > LIMIT,
      hits: hits.slice(0, LIMIT),
    };
  }

  async #scenes(projectId: string, expression: string): Promise<SearchHit[]> {
    const { rows } = await this.driver.query(
      `SELECT s.id, s.title, c.title,
              snippet(scene_fts, -1, ?, ?, '…', ${SNIPPET_TOKENS}),
              ${SCENE_RANK}
       FROM scene_fts
       JOIN scene s   ON s.id = scene_fts.scene_id
       JOIN chapter c ON c.id = s.chapter_id
       JOIN book b    ON b.id = c.book_id
       WHERE scene_fts MATCH ? AND b.project_id = ? AND s.deleted_at IS NULL
       ORDER BY ${SCENE_RANK}
       LIMIT ${LIMIT + 1}`,
      [SNIPPET_OPEN, SNIPPET_CLOSE, expression, projectId], 'all');

    return (rows as unknown[][]).map((r) => ({
      kind: 'scene' as const,
      id: r[0] as string,
      title: (r[1] as string | null) ?? 'Untitled scene',
      context: r[2] as string | null,
      snippet: parseSnippet(String(r[3] ?? '')),
      score: Number(r[4]),
    }));
  }

  async #codex(projectId: string, expression: string): Promise<SearchHit[]> {
    // Scoped in SQL rather than filtered afterwards: a LIMIT applied before the
    // scope would silently drop this project's results in favour of another's.
    const { rows } = await this.driver.query(
      `SELECT codex_fts.owner_table, codex_fts.owner_id, codex_fts.name,
              snippet(codex_fts, -1, ?, ?, '…', ${SNIPPET_TOKENS}),
              ${CODEX_RANK}
       FROM codex_fts
       WHERE codex_fts MATCH ?
         AND ((codex_fts.owner_table = 'entity' AND codex_fts.owner_id IN
                 (SELECT id FROM entity WHERE project_id = ? AND deleted_at IS NULL))
           OR (codex_fts.owner_table = 'fact' AND codex_fts.owner_id IN
                 (SELECT id FROM fact WHERE project_id = ? AND deleted_at IS NULL))
           OR (codex_fts.owner_table = 'note' AND codex_fts.owner_id IN
                 (SELECT id FROM note WHERE project_id = ? AND deleted_at IS NULL)))
       ORDER BY ${CODEX_RANK}
       LIMIT ${LIMIT + 1}`,
      [SNIPPET_OPEN, SNIPPET_CLOSE, expression, projectId, projectId, projectId], 'all');

    const LABEL: Record<string, string> = {
      entity: 'Codex entry', fact: 'Fact', note: 'Note',
    };
    return (rows as unknown[][]).map((r) => ({
      kind: r[0] as SearchKind,
      id: r[1] as string,
      title: (r[2] as string | null) || 'Untitled',
      context: LABEL[r[0] as string] ?? null,
      snippet: parseSnippet(String(r[3] ?? '')),
      score: Number(r[4]),
    }));
  }
}
