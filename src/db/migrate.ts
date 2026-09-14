import type { SqlDriver } from './driver';
import { MIGRATIONS, type Migration } from './migrations';

export interface MigrationResult {
  from: number;
  to: number;
  applied: { version: number; name: string; ms: number }[];
}

async function userVersion(driver: SqlDriver): Promise<number> {
  const { rows } = await driver.query('PRAGMA user_version', [], 'get');
  return Number((rows as unknown[])[0] ?? 0);
}

/**
 * `schema_migration` is an append-only audit log, NOT the mechanism. If it were
 * ever lost or corrupted, startup still works — which is exactly why it is not
 * the source of truth. docs/15 §3b.
 */
async function ensureAuditTable(driver: SqlDriver): Promise<void> {
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )`);
}

export async function migrate(
  driver: SqlDriver,
  migrations: Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  const from = await userVersion(driver);
  const applied: MigrationResult['applied'] = [];
  await ensureAuditTable(driver);

  for (const m of migrations.slice().sort((a, b) => a.version - b.version)) {
    if (m.version <= from) continue;
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`migration version must be a positive integer: ${m.version}`);
    }
    const t0 = performance.now();
    await driver.exec('BEGIN');
    try {
      // Multi-statement SQL: exec(), not prepare(), which consumes only the
      // first statement.
      await driver.exec(m.sql);
      // PRAGMA cannot be parameterised; the integer is validated above.
      await driver.exec(`PRAGMA user_version = ${m.version}`);
      const ms = Math.round(performance.now() - t0);
      await driver.query(
        'INSERT INTO schema_migration (version, name, applied_at, duration_ms) VALUES (?,?,?,?)',
        [m.version, m.name, Date.now(), ms],
        'run',
      );
      await driver.exec('COMMIT');
      applied.push({ version: m.version, name: m.name, ms });
    } catch (e) {
      try { await driver.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw e;
    }
  }

  return { from, to: await userVersion(driver), applied };
}
