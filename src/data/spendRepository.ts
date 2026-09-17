import type { SqlDriver } from '../db/driver';
import type { RunsRepository } from './runsRepository';
import { deviceId } from './ids';
import {
  capsFromSettings, localDayStart, settingsWithCaps, spendLevel, validateCaps,
  type SpendCaps, type SpendMeter,
} from '../domain/spend';

/**
 * Spend caps and the meter that reads them ([D17](../../docs/10-decisions.md)).
 *
 * The caps live in `project.settings_json`, the column the schema set aside
 * for "model roles, budgets, ui prefs" — a project setting, not a table, and
 * so no migration. The sum comes from `ai_run.cost_usd`, which the drafter
 * writes from the provider's own token counts against the profile's prices.
 *
 * A change to the caps is a change to the writer's record of what they
 * allowed, so it bumps `rev` and writes `op_log` in the same transaction like
 * any other project mutation.
 */
export class SpendRepository {
  constructor(private readonly driver: SqlDriver, private readonly runs: RunsRepository) {}

  async caps(projectId: string): Promise<SpendCaps> {
    return capsFromSettings(await this.#settings(projectId));
  }

  async setCaps(projectId: string, caps: SpendCaps): Promise<SpendCaps> {
    const clean = validateCaps(caps);
    const now = Date.now();
    const settings = settingsWithCaps(await this.#settings(projectId), clean);
    await this.driver.batch([
      {
        sql: `UPDATE project SET settings_json = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [settings, now, projectId],
      },
      {
        sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
        params: [deviceId(), 'project', projectId, 'update', JSON.stringify({ settings: { spend: clean } }), now],
      },
    ]);
    return clean;
  }

  /** Today's spend against the caps. `now` is injectable so a test can pick the day. */
  async meter(projectId: string, now = Date.now()): Promise<SpendMeter> {
    const dayStart = localDayStart(now);
    const [caps, todayUsd, unpricedRuns] = await Promise.all([
      this.caps(projectId),
      this.runs.spentSince(projectId, dayStart),
      this.runs.unpricedSince(projectId, dayStart),
    ]);
    return { todayUsd, unpricedRuns, caps, level: spendLevel(todayUsd, caps), dayStart };
  }

  async #settings(projectId: string): Promise<string | null> {
    const { rows } = await this.driver.query(
      'SELECT settings_json FROM project WHERE id = ?', [projectId], 'all');
    const row = (rows as unknown[][])[0];
    if (!row) throw new Error('That project no longer exists.');
    return (row[0] as string | null) ?? null;
  }
}
