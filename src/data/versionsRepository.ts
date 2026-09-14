import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import { countWords } from '../text/words';
import type { ManuscriptRepository } from './manuscriptRepository';

/**
 * Kept drafts of a scene, and getting one back.
 *
 * A version is not an autosave. Autosave is continuous and unnamed and there
 * would be thousands of them; a version is a point the writer chose, or that an
 * AI run will choose on their behalf in Phase 2 — which is what the `origin`
 * column is for and why it is not defaulted away.
 *
 * Two rules hold this together, and both exist because the thing being risked
 * is somebody's only copy of their prose:
 *
 * **Restoring never destroys.** The prose that is on the page when a restore
 * starts is kept first, as its own version, before anything overwrites it. So
 * "restore" is always undoable by restoring the other one, and a writer who
 * picked the wrong draft from a list has lost nothing. The ordering is the
 * whole of it: the snapshot commits before the overwrite, so a failure between
 * them leaves an extra copy of unchanged text rather than a hole where a scene
 * was.
 *
 * **Prose reaches the scene by one path only.** A restore writes through
 * `ManuscriptRepository.saveSceneContent`, the same call the editor's autosave
 * makes, so the word count and the search index follow the prose without this
 * file knowing they exist. A second write path here is a second place for
 * `scene_fts` to fall behind the manuscript.
 */

export type VersionOrigin = 'manual' | 'ai_draft' | 'ai_revision' | 'import';

/** A kept draft, without its prose — what a list renders. */
export interface SceneVersion {
  id: string;
  sceneId: string;
  label: string | null;
  parentVersionId: string | null;
  origin: VersionOrigin;
  wordCount: number;
  /** The version the scene's current prose was taken from. At most one per scene. */
  isActive: boolean;
  createdAt: number;
}

export interface VersionContent {
  contentJson: string | null;
  contentText: string | null;
}

interface Statement { sql: string; params: unknown[] }

export class VersionsRepository {
  constructor(
    private readonly driver: SqlDriver,
    private readonly manuscript: ManuscriptRepository,
  ) {}

  /* ------------------------------------------------------------------ reads */

  /**
   * Newest first: the draft a writer wants back is almost always a recent one.
   *
   * Ties break on `rowid`, not on `id`. Two versions can share a millisecond,
   * and a uuidv7 minted in the same one differs only in its random tail — so
   * ordering by id would put them in a coin-flip order that changes between
   * reads of an unchanged table.
   */
  async list(sceneId: string): Promise<SceneVersion[]> {
    const rows = await this.#all(
      `SELECT id, scene_id, label, parent_version_id, origin, word_count, is_active, created_at
       FROM scene_version WHERE scene_id = ? ORDER BY created_at DESC, rowid DESC`, [sceneId]);
    return rows.map(toVersion);
  }

  async get(id: string): Promise<(SceneVersion & VersionContent) | null> {
    const rows = await this.#all(
      `SELECT id, scene_id, label, parent_version_id, origin, word_count, is_active, created_at,
              content_json, content_text
       FROM scene_version WHERE id = ?`, [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      ...toVersion(r),
      contentJson: r[8] as string | null,
      contentText: r[9] as string | null,
    };
  }

  /* --------------------------------------------------------------- snapshot */

  /**
   * Keep the scene as it stands now.
   *
   * Returns `created: false` and the existing version when the active one
   * already holds exactly this text and no new label was asked for. Pressing
   * "keep this version" twice is a thing writers do, and a list of identical
   * drafts is a list nobody can choose from.
   */
  async snapshot(
    sceneId: string, options: { label?: string | null; origin?: VersionOrigin } = {},
  ): Promise<{ version: SceneVersion; created: boolean }> {
    const content = await this.manuscript.getSceneContent(sceneId);
    if (!content) throw new Error(`no such scene: ${sceneId}`);

    const active = await this.#active(sceneId);
    if (active && options.label == null && active.contentText === (content.contentText ?? null)) {
      return { version: withoutContent(active), created: false };
    }

    const now = Date.now();
    const id = uuidv7(now);
    const wordCount = countWords(content.contentText ?? '').words;
    const version: SceneVersion = {
      id,
      sceneId,
      label: options.label ?? null,
      // The draft this one grew out of, which is whatever the prose was last
      // taken from. It is what makes the list a history rather than a heap.
      parentVersionId: active?.id ?? null,
      origin: options.origin ?? 'manual',
      wordCount,
      isActive: true,
      createdAt: now,
    };

    await this.driver.batch([
      ...this.#deactivate(sceneId),
      {
        sql: `INSERT INTO scene_version
                (id,scene_id,label,parent_version_id,origin,content_json,content_text,
                 word_count,is_active,created_at)
              VALUES (?,?,?,?,?,?,?,?,1,?)`,
        params: [
          id, sceneId, version.label, version.parentVersionId, version.origin,
          content.contentJson, content.contentText, wordCount, now,
        ],
      },
      // The prose goes in the log, not just the fact of a snapshot: a sync that
      // could replay only the row would replicate an empty draft with a label.
      this.#op(id, 'insert', { ...version, contentText: content.contentText }, now),
    ], true);

    return { version, created: true };
  }

  /* ---------------------------------------------------------------- restore */

  /**
   * Put a kept draft back on the page.
   *
   * The prose that was there is snapshotted first, in its own transaction, and
   * that snapshot's id comes back so the caller can offer the way out by name.
   */
  async restore(
    projectId: string, versionId: string,
  ): Promise<{ sceneId: string; keptId: string | null; wordCount: number }> {
    const version = await this.get(versionId);
    if (!version) throw new Error(`no such version: ${versionId}`);

    const kept = await this.snapshot(version.sceneId, { origin: 'manual' });

    const { wordCount } = await this.manuscript.saveSceneContent(version.sceneId, {
      contentJson: version.contentJson,
      contentText: version.contentText,
    });

    const now = Date.now();
    await this.driver.batch([
      ...this.#deactivate(version.sceneId),
      { sql: 'UPDATE scene_version SET is_active = 1 WHERE id = ?', params: [versionId] },
      this.#op(versionId, 'update', { isActive: true }, now),
    ], true);

    // The whole scene's prose just changed, so its mentions are about text that
    // is no longer there. Unlike a keystroke this is a discrete event, which is
    // why re-detecting here is right and re-detecting on autosave is not.
    await this.manuscript.reindexScene(projectId, version.sceneId);

    return {
      sceneId: version.sceneId,
      keptId: kept.created ? kept.version.id : null,
      wordCount,
    };
  }

  /* ---------------------------------------------------------------- updates */

  async relabel(id: string, label: string): Promise<void> {
    const now = Date.now();
    const clean = label.trim() || null;
    await this.driver.batch([
      { sql: 'UPDATE scene_version SET label = ? WHERE id = ?', params: [clean, id] },
      this.#op(id, 'update', { label: clean }, now),
    ], true);
  }

  /**
   * Delete a kept draft, for good.
   *
   * A hard delete, because `scene_version` has no tombstone column and a
   * discarded draft is the one thing in this schema a writer genuinely means to
   * be gone. Children are re-parented onto this one's parent first: the
   * foreign key would otherwise refuse the delete, and silently orphaning them
   * would break the chain that makes the list a history.
   */
  async remove(id: string): Promise<void> {
    const now = Date.now();
    const rows = await this.#all(
      'SELECT parent_version_id FROM scene_version WHERE id = ?', [id]);
    if (!rows.length) return;
    const parent = rows[0]![0] as string | null;
    const children = (await this.#all(
      'SELECT id FROM scene_version WHERE parent_version_id = ?', [id])).map((r) => String(r[0]));

    await this.driver.batch([
      ...children.flatMap((child) => [
        {
          sql: 'UPDATE scene_version SET parent_version_id = ? WHERE id = ?',
          params: [parent, child],
        },
        this.#op(child, 'update', { parentVersionId: parent }, now),
      ]),
      { sql: 'DELETE FROM scene_version WHERE id = ?', params: [id] },
      this.#op(id, 'delete', null, now),
    ], true);
  }

  /* ---------------------------------------------------------------- private */

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }

  async #active(sceneId: string): Promise<(SceneVersion & VersionContent) | null> {
    const rows = await this.#all(
      `SELECT id FROM scene_version WHERE scene_id = ? AND is_active = 1
       ORDER BY created_at DESC, rowid DESC LIMIT 1`, [sceneId]);
    const id = rows[0]?.[0];
    return id ? this.get(String(id)) : null;
  }

  #deactivate(sceneId: string): Statement[] {
    return [{
      sql: 'UPDATE scene_version SET is_active = 0 WHERE scene_id = ? AND is_active = 1',
      params: [sceneId],
    }];
  }

  #op(rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [
        deviceId(), 'scene_version', rowId, op,
        payload === null ? null : JSON.stringify(payload), ts,
      ],
    };
  }
}

/** The listing shape of a row that was read with its prose attached. */
function withoutContent(v: SceneVersion & VersionContent): SceneVersion {
  return {
    id: v.id, sceneId: v.sceneId, label: v.label, parentVersionId: v.parentVersionId,
    origin: v.origin, wordCount: v.wordCount, isActive: v.isActive, createdAt: v.createdAt,
  };
}

function toVersion(r: unknown[]): SceneVersion {
  return {
    id: r[0] as string,
    sceneId: r[1] as string,
    label: r[2] as string | null,
    parentVersionId: r[3] as string | null,
    origin: r[4] as VersionOrigin,
    wordCount: Number(r[5] ?? 0),
    isActive: Number(r[6]) === 1,
    createdAt: Number(r[7]),
  };
}
