import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqlDriver } from './driver';
import * as schema from './schema';

/**
 * Drizzle over sqlite-proxy.
 *
 * There is no official drizzle entry for @sqlite.org/sqlite-wasm, and
 * sqlite-proxy is the documented path for an async/RPC connection — which is
 * exactly what a worker boundary is. The callback must return POSITIONAL
 * ARRAYS, which is what the conformance suite pins down.
 *
 * Note what is NOT here: migrations. drizzle-orm/sqlite-proxy/migrator imports
 * node:fs and cannot run in a browser at all, so migration application is
 * hand-rolled in migrate.ts. docs/15 §3b.
 */
export function makeDb(driver: SqlDriver) {
  return drizzle(
    async (sql, params, method) => {
      const { rows } = await driver.query(sql, params, method);
      return { rows: rows as unknown[] };
    },
    { schema },
  );
}

export type Db = ReturnType<typeof makeDb>;
export { schema };
