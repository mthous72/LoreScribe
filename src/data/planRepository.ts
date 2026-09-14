import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import { keyBetween } from '../domain/sortKey';
import { findGaps, type Gap } from '../domain/gapFinder';

/**
 * Arcs, beats, and which scenes carry them.
 *
 * A beat is what a scene has to accomplish, and it is the reason this exists
 * before the compiler rather than after it ([D29](../../docs/10-decisions.md)).
 * Doc 03's scene brief has always carried `beats: BeatTarget[]`; a brief with
 * perfect facts and no beat knows everything about the world and nothing about
 * what the scene is for, which is the shapeless output the whole temporal graph
 * exists to beat.
 *
 * Two shapes are worth knowing before reading the methods:
 *
 *  - **A beat belongs to exactly one arc** (`beat.arc_id` is NOT NULL), so there
 *    is no such thing as a loose beat. An arc is the thing a beat is a step of.
 *  - **Beats and scenes are many-to-many, with a role.** One beat can be set up
 *    in one scene and paid off three chapters later; one scene can serve several
 *    beats at once. That is `beat_scene`, and it is why "which chapter is this
 *    beat in" is a planning intention (`beat.target_chapter_id`) rather than the
 *    answer.
 */

export type ArcKind =
  'main_plot' | 'subplot' | 'character' | 'relationship' | 'mystery' | 'theme';
export type BeatFunction =
  'setup' | 'inciting' | 'turn' | 'midpoint' | 'crisis' | 'climax' | 'resolution';
export type BeatRole = 'setup' | 'develop' | 'payoff' | 'echo';

export interface Arc {
  id: string; bookId: string; kind: string; name: string; sortKey: string;
  colour: string | null; ownerEntityId: string | null; premise: string | null;
  want: string | null; need: string | null; lie: string | null; ghost: string | null;
  status: string | null; rev: number;
}

export interface Beat {
  id: string; arcId: string; sortKey: string; title: string; summary: string | null;
  function: string | null; tension: number | null; targetChapterId: string | null;
  status: string | null; rev: number;
  /** Scenes that carry it, in reading order. Empty means unrealised. */
  sceneIds: string[];
}

/** A beat as it appears beside a scene: what this scene has to accomplish. */
export interface SceneBeat {
  beatId: string; arcId: string; arcName: string; arcColour: string | null;
  title: string; summary: string | null; function: string | null; role: string;
}

export interface ArcPatch {
  name?: string; kind?: string; colour?: string | null; ownerEntityId?: string | null;
  premise?: string | null; want?: string | null; need?: string | null;
  lie?: string | null; ghost?: string | null; status?: string | null;
}
export interface BeatPatch {
  title?: string; summary?: string | null; function?: string | null;
  tension?: number | null; targetChapterId?: string | null; status?: string | null;
}

/** One cell of the beat/scene grid. */
export interface MatrixScene {
  id: string; title: string | null; chapterTitle: string | null; wordCount: number;
}
export interface Matrix {
  scenes: MatrixScene[];
  arcs: { arc: Arc; beats: Beat[] }[];
  /**
   * Unrealised beats and orphan scenes, from `findGaps`.
   *
   * Computed by the gap finder rather than re-derived here. It has been built
   * and tested since Phase 0b with no caller at all, and its rules for these two
   * are exactly the grid's: a beat no scene realises, and a scene that has prose
   * but serves no beat. A second implementation would be a second opinion.
   */
  gaps: Gap[];
}

interface Statement { sql: string; params: unknown[] }

export class PlanRepository {
  constructor(private readonly driver: SqlDriver) {}

  /* ------------------------------------------------------------------ reads */

  async listArcs(bookId: string): Promise<Arc[]> {
    const rows = await this.#all(
      `SELECT id, book_id, kind, name, sort_key, colour, owner_entity_id, premise,
              want, need, lie, ghost, status, rev
       FROM arc WHERE book_id = ? AND deleted_at IS NULL ORDER BY sort_key`, [bookId]);
    return rows.map(toArc);
  }

  /** Every beat of a book, with the scenes carrying it. Two queries, not N. */
  async listBeats(bookId: string): Promise<Beat[]> {
    const rows = await this.#all(
      `SELECT b.id, b.arc_id, b.sort_key, b.title, b.summary, b.function, b.tension,
              b.target_chapter_id, b.status, b.rev
       FROM beat b JOIN arc a ON a.id = b.arc_id
       WHERE a.book_id = ? AND b.deleted_at IS NULL AND a.deleted_at IS NULL
       ORDER BY a.sort_key, b.sort_key`, [bookId]);
    const links = await this.#all(
      `SELECT bs.beat_id, bs.scene_id FROM beat_scene bs
       JOIN beat b ON b.id = bs.beat_id
       JOIN arc a ON a.id = b.arc_id
       JOIN scene s ON s.id = bs.scene_id AND s.deleted_at IS NULL
       WHERE a.book_id = ? ORDER BY s.global_rank`, [bookId]);
    const byBeat = new Map<string, string[]>();
    for (const l of links) {
      const at = byBeat.get(String(l[0])) ?? [];
      at.push(String(l[1]));
      byBeat.set(String(l[0]), at);
    }
    return rows.map((r) => ({ ...toBeat(r), sceneIds: byBeat.get(String(r[0])) ?? [] }));
  }

  /** What this scene has to accomplish — the panel beside the editor. */
  async beatsForScene(sceneId: string): Promise<SceneBeat[]> {
    const rows = await this.#all(
      `SELECT b.id, a.id, a.name, a.colour, b.title, b.summary, b.function, bs.role
       FROM beat_scene bs
       JOIN beat b ON b.id = bs.beat_id AND b.deleted_at IS NULL
       JOIN arc a ON a.id = b.arc_id AND a.deleted_at IS NULL
       WHERE bs.scene_id = ? ORDER BY a.sort_key, b.sort_key`, [sceneId]);
    return rows.map((r) => ({
      beatId: r[0] as string, arcId: r[1] as string, arcName: r[2] as string,
      arcColour: r[3] as string | null, title: r[4] as string,
      summary: r[5] as string | null, function: r[6] as string | null,
      role: (r[7] as string | null) ?? 'develop',
    }));
  }

  /**
   * The grid: every beat against every scene, plus what is missing.
   *
   * The two questions it answers are the ones doc 05 says jump out of it — which
   * planned beats no scene realises, and which written scenes serve no beat.
   */
  async matrix(bookId: string): Promise<Matrix> {
    const [arcs, beats, sceneRows] = await Promise.all([
      this.listArcs(bookId),
      this.listBeats(bookId),
      this.#all(
        `SELECT s.id, s.title, c.title, s.word_count, s.global_rank
         FROM scene s JOIN chapter c ON c.id = s.chapter_id
         WHERE c.book_id = ? AND s.deleted_at IS NULL AND c.deleted_at IS NULL
         ORDER BY s.global_rank`, [bookId]),
    ]);

    const scenes: MatrixScene[] = sceneRows.map((r) => ({
      id: r[0] as string, title: r[1] as string | null,
      chapterTitle: r[2] as string | null, wordCount: Number(r[3] ?? 0),
    }));

    const gaps = findGaps({
      entities: [], aliases: [], chapters: [], threads: [], references: [],
      arcs: arcs.map((a) => ({ id: a.id, name: a.name })),
      beats: beats.map((b) => ({ id: b.id, title: b.title, arcId: b.arcId, sceneIds: b.sceneIds })),
      scenes: sceneRows.map((r) => ({
        id: r[0] as string, title: r[1] as string | null,
        globalRank: String(r[4]), wordCount: Number(r[3] ?? 0),
      })),
    });

    return {
      scenes,
      arcs: arcs.map((arc) => ({ arc, beats: beats.filter((b) => b.arcId === arc.id) })),
      gaps,
    };
  }

  /* ---------------------------------------------------------------- writes */

  async createArc(bookId: string, name: string, kind: ArcKind = 'main_plot'): Promise<Arc> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('arc', 'book_id', bookId);
    const arc: Arc = {
      id, bookId, kind, name, sortKey, colour: null, ownerEntityId: null,
      premise: null, want: null, need: null, lie: null, ghost: null,
      status: 'planned', rev: 1,
    };
    await this.driver.batch([
      {
        sql: `INSERT INTO arc (id,book_id,kind,name,sort_key,status,created_at,updated_at,rev)
              VALUES (?,?,?,?,?, 'planned', ?,?,1)`,
        params: [id, bookId, kind, name, sortKey, now, now],
      },
      this.#op('arc', id, 'insert', arc, now),
    ], true);
    return arc;
  }

  async updateArc(id: string, patch: ArcPatch): Promise<void> {
    await this.#patch('arc', id, patch, {
      name: 'name', kind: 'kind', colour: 'colour', ownerEntityId: 'owner_entity_id',
      premise: 'premise', want: 'want', need: 'need', lie: 'lie', ghost: 'ghost',
      status: 'status',
    });
  }

  /** Soft delete, taking the arc's beats with it — a beat has no life without one. */
  async removeArc(id: string): Promise<void> {
    const now = Date.now();
    const beats = (await this.#all(
      'SELECT id FROM beat WHERE arc_id = ? AND deleted_at IS NULL', [id])).map((r) => String(r[0]));
    await this.driver.batch([
      ...beats.flatMap((beatId) => [
        {
          sql: `UPDATE beat SET deleted_at = ?, updated_at = ?, rev = rev + 1
                WHERE id = ? AND deleted_at IS NULL`,
          params: [now, now, beatId],
        },
        this.#op('beat', beatId, 'delete', null, now),
      ]),
      {
        sql: `UPDATE arc SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('arc', id, 'delete', null, now),
    ], true);
  }

  async createBeat(arcId: string, title: string, afterId?: string): Promise<Beat> {
    const now = Date.now();
    const id = uuidv7(now);
    const sortKey = await this.#keyFor('beat', 'arc_id', arcId, afterId);
    const beat: Beat = {
      id, arcId, sortKey, title, summary: null, function: null, tension: null,
      targetChapterId: null, status: 'planned', rev: 1, sceneIds: [],
    };
    await this.driver.batch([
      {
        sql: `INSERT INTO beat (id,arc_id,sort_key,title,status,created_at,updated_at,rev)
              VALUES (?,?,?,?, 'planned', ?,?,1)`,
        params: [id, arcId, sortKey, title, now, now],
      },
      this.#op('beat', id, 'insert', beat, now),
    ], true);
    return beat;
  }

  async updateBeat(id: string, patch: BeatPatch): Promise<void> {
    await this.#patch('beat', id, patch, {
      title: 'title', summary: 'summary', function: 'function', tension: 'tension',
      targetChapterId: 'target_chapter_id', status: 'status',
    });
  }

  async removeBeat(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE beat SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      // The links go with it: a beat_scene row pointing at a deleted beat would
      // make a scene look like it serves something that is no longer planned.
      { sql: 'DELETE FROM beat_scene WHERE beat_id = ?', params: [id] },
      this.#op('beat', id, 'delete', null, now),
    ], true);
  }

  /* ------------------------------------------------------- beats and scenes */

  /**
   * Say that this scene carries this beat, in this role.
   *
   * Idempotent on the pair, because the primary key is the pair: linking twice
   * changes the role rather than failing, which is what a writer pressing the
   * same button twice means.
   */
  async linkBeat(beatId: string, sceneId: string, role: BeatRole = 'develop'): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `INSERT INTO beat_scene (beat_id,scene_id,role) VALUES (?,?,?)
              ON CONFLICT(beat_id, scene_id) DO UPDATE SET role = excluded.role`,
        params: [beatId, sceneId, role],
      },
      this.#op('beat_scene', `${beatId}:${sceneId}`, 'update', { role }, now),
    ], true);
  }

  async unlinkBeat(beatId: string, sceneId: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: 'DELETE FROM beat_scene WHERE beat_id = ? AND scene_id = ?',
        params: [beatId, sceneId],
      },
      this.#op('beat_scene', `${beatId}:${sceneId}`, 'delete', null, now),
    ], true);
  }

  /* ---------------------------------------------------------------- private */

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }

  /** Only the keys given, so a form that knows half the fields cannot blank the rest. */
  async #patch(
    table: string, id: string, patch: object, columns: Record<string, string>,
  ): Promise<void> {
    const values = patch as Record<string, unknown>;
    const keys = Object.keys(values).filter((k) => values[k] !== undefined && k in columns);
    if (!keys.length) return;
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE ${table} SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')},
                updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [...keys.map((k) => values[k] ?? null), now, id],
      },
      this.#op(table, id, 'update', patch, now),
    ], true);
  }

  async #keyFor(
    table: string, scopeColumn: string, scopeId: string, afterId?: string,
  ): Promise<string> {
    const rows = await this.#all(
      `SELECT id, sort_key FROM ${table}
       WHERE ${scopeColumn} = ? AND deleted_at IS NULL ORDER BY sort_key`, [scopeId]);
    const siblings = rows.map((r) => ({ id: String(r[0]), key: String(r[1]) }));
    if (afterId) {
      const i = siblings.findIndex((s) => s.id === afterId);
      if (i >= 0) return keyBetween(siblings[i]!.key, siblings[i + 1]?.key ?? null);
    }
    return keyBetween(siblings[siblings.length - 1]?.key ?? null, null);
  }

  #op(table: string, rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), table, rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}

function toArc(r: unknown[]): Arc {
  return {
    id: r[0] as string, bookId: r[1] as string, kind: r[2] as string, name: r[3] as string,
    sortKey: r[4] as string, colour: r[5] as string | null,
    ownerEntityId: r[6] as string | null, premise: r[7] as string | null,
    want: r[8] as string | null, need: r[9] as string | null, lie: r[10] as string | null,
    ghost: r[11] as string | null, status: r[12] as string | null, rev: Number(r[13]),
  };
}

function toBeat(r: unknown[]): Omit<Beat, 'sceneIds'> {
  return {
    id: r[0] as string, arcId: r[1] as string, sortKey: r[2] as string,
    title: r[3] as string, summary: r[4] as string | null, function: r[5] as string | null,
    tension: r[6] === null ? null : Number(r[6]),
    targetChapterId: r[7] as string | null, status: r[8] as string | null, rev: Number(r[9]),
  };
}
