import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions.
 *
 * db/schema.sql stays the canonical artefact — it is what migration 001 applies,
 * and the schema-equivalence test proves the two agree. These definitions exist
 * for type-safe queries, and only the tables Phase 0 actually touches are
 * declared. The remaining 35 arrive in Phase 1 alongside the code that uses
 * them; declaring them now would be 500 lines nothing reads.
 */

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  premise: text('premise'),
  genre: text('genre'),
  audience: text('audience'),
  contentRating: text('content_rating'),
  proseRegister: integer('prose_register'),
  calendarId: text('calendar_id'),
  storyEpoch: integer('story_epoch'),
  settingsJson: text('settings_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  rev: integer('rev').notNull().default(1),
});

export const opLog = sqliteTable('op_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id').notNull(),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
  op: text('op').notNull(),
  payload: text('payload'),
  ts: integer('ts').notNull(),
});
