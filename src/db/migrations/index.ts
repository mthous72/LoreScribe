// Migration SQL is inlined at BUILD time, never read from disk at run time.
// That is not a stylistic choice: the ORM migrator this project once planned to
// use (drizzle-orm/sqlite-proxy/migrator, removed in D28) imports
// node:fs and node:crypto and cannot run in a browser at all, so migration
// application has always been our own. docs/15 §3b.
import init001 from '../../../db/schema.sql?raw';
import seed002 from '../../../db/migrations/002_seed_entity_types.sql?raw';
import repair003 from '../../../db/migrations/003_repair_schema_drift.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// db/schema.sql is imported rather than copied, so migration 001 and the
// canonical schema cannot drift apart FOR A FRESH DATABASE. It guarantees
// nothing for an existing one: migrate() skips every migration at or below
// user_version, so editing 001 in place silently reaches nobody who already
// has a database. That is exactly what happened — see 003, and the drift test
// in src/db/migrate.test.ts that now makes it impossible to repeat quietly.
//
// From here, a change to db/schema.sql needs a matching migration. Always.
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: init001 },
  { version: 2, name: 'seed_entity_types', sql: seed002 },
  { version: 3, name: 'repair_schema_drift', sql: repair003 },
];
