import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';

export interface Project {
  id: string;
  title: string;
  premise: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
}

/**
 * The repository layer, and the op_log write path.
 *
 * Sync is not being built ([D2](../../docs/10-decisions.md)), but rev, soft
 * deletes and op_log exist from commit one so that an optional sync layer is a
 * feature rather than a rewrite. Nothing reads op_log yet — it is written now
 * because it cannot be reconstructed later.
 *
 * Every mutation and its op_log row go in ONE batch, which is one transaction,
 * so a failure to log rolls the mutation back.
 *
 * That reads like a violation of doc 08's rule 6 — "telemetry must never break
 * generation" — and is deliberately carved out of it. The test is whether the
 * record can be reconstructed afterwards. A cost figure can; the `ai_run` row
 * still holds the tokens. `op_log` cannot: nothing else records *what changed*,
 * so a dropped entry leaves a log that silently disagrees with the data it
 * describes, and everything downstream works from a fiction. A best-effort sync
 * log is worse than none, because it looks trustworthy.
 *
 * Anything written for our benefit is best-effort and wrapped. Anything that is
 * part of the writer's record is atomic with it.
 */
export class ProjectRepository {
  constructor(private readonly driver: SqlDriver) {}

  async create(title: string, premise?: string): Promise<Project> {
    const now = Date.now();
    const row: Project = {
      id: uuidv7(now), title, premise: premise ?? null, createdAt: now, updatedAt: now, rev: 1,
    };
    await this.driver.batch([
      {
        sql: 'INSERT INTO project (id,title,premise,created_at,updated_at,rev) VALUES (?,?,?,?,?,1)',
        params: [row.id, row.title, row.premise, now, now],
      },
      this.#op('project', row.id, 'insert', row, now),
    ]);
    return row;
  }

  async rename(id: string, title: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: 'UPDATE project SET title = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND deleted_at IS NULL',
        params: [title, now, id],
      },
      this.#op('project', id, 'update', { title }, now),
    ]);
  }

  /** Soft delete. The row stays so a future sync can replicate the tombstone. */
  async remove(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        // updated_at moves too: a sync keyed on it would otherwise never see
        // the tombstone, which is the one change it most needs to replicate.
        // `deleted_at IS NULL` makes a repeat delete a no-op rather than a
        // second tombstone and a second rev bump.
        sql: `UPDATE project SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('project', id, 'delete', null, now),
    ]);
  }

  async list(): Promise<Project[]> {
    const { rows } = await this.driver.query(
      `SELECT id,title,premise,created_at,updated_at,rev FROM project
       WHERE deleted_at IS NULL ORDER BY updated_at DESC`, [], 'all');
    return (rows as unknown[][]).map((r) => ({
      id: r[0] as string, title: r[1] as string, premise: r[2] as string | null,
      createdAt: r[3] as number, updatedAt: r[4] as number, rev: r[5] as number,
    }));
  }

  async opLogCount(): Promise<number> {
    const { rows } = await this.driver.query('SELECT COUNT(*) FROM op_log', [], 'get');
    return Number((rows as unknown[])[0]);
  }

  #op(table: string, rowId: string, op: string, payload: unknown, ts: number) {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), table, rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}
