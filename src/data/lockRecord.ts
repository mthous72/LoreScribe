import type { SqlDriver } from '../db/driver';

/**
 * The `session_lock` row — evidence, not enforcement.
 *
 * The lock itself is Web Locks (see `src/lock/databaseLock.ts`). This table
 * cannot grant or deny anything, because the context that would need to read it
 * is by definition the one that could not open the database. What it can do is
 * outlive a session that died: a row still here when the next one opens means
 * the previous one never released, which is worth knowing before trusting the
 * file.
 */
export interface StaleLock {
  holderId: string;
  holderLabel: string | null;
  acquiredAt: number;
  heartbeatAt: number;
}

/** Any row left behind by a previous session, cleared as it is reported. */
export async function takeOverLockRecord(
  driver: SqlDriver, holderId: string, label: string,
): Promise<StaleLock | null> {
  const { rows } = await driver.query(
    'SELECT holder_id, holder_label, acquired_at, heartbeat_at FROM session_lock WHERE id = 1',
    [], 'get');
  const r = rows as unknown[];
  const stale: StaleLock | null = r.length
    ? {
      holderId: String(r[0]), holderLabel: r[1] == null ? null : String(r[1]),
      acquiredAt: Number(r[2]), heartbeatAt: Number(r[3]),
    }
    : null;

  const now = Date.now();
  await driver.query(
    `INSERT INTO session_lock (id, holder_id, holder_label, acquired_at, heartbeat_at)
     VALUES (1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       holder_id = excluded.holder_id, holder_label = excluded.holder_label,
       acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
    [holderId, label, now, now], 'run');
  return stale;
}

export async function beatLockRecord(driver: SqlDriver, holderId: string): Promise<void> {
  await driver.query(
    'UPDATE session_lock SET heartbeat_at = ? WHERE id = 1 AND holder_id = ?',
    [Date.now(), holderId], 'run');
}

/** Clean release. Its absence next time is what says the session ended properly. */
export async function releaseLockRecord(driver: SqlDriver, holderId: string): Promise<void> {
  await driver.query('DELETE FROM session_lock WHERE id = 1 AND holder_id = ?', [holderId], 'run');
}
