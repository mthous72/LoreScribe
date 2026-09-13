// Migration SQL is inlined at BUILD time, never read from disk at run time.
// That is not a stylistic choice: drizzle-orm/sqlite-proxy/migrator imports
// node:fs and node:crypto and cannot run in a browser at all, so migration
// application sits outside Drizzle entirely. docs/15 §3b.
import init001 from '../../../db/schema.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// db/schema.sql is imported rather than copied, so migration 001 and the
// canonical schema cannot drift apart.
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: init001 },
];
