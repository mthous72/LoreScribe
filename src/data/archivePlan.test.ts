import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ARCHIVE_TABLES } from './archive';

/**
 * The export plan has to agree with the schema it exports.
 *
 * Four of eighteen specs referenced a `project_id` that does not exist — arcs
 * and threads hang off a book, not a project — and the symptom was the whole
 * backup throwing at run time. A plan that names columns is a plan that can
 * drift from the schema, so it is checked against the real thing rather than
 * against an idea of it. Runs the actual db/schema.sql in Node's own SQLite.
 */
function schemaDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('db/schema.sql', 'utf8'));
  db.exec(readFileSync('db/migrations/002_seed_entity_types.sql', 'utf8'));
  return db;
}

describe('the archive export plan', () => {
  const db = schemaDb();
  const columnsOf = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));

  it.each(ARCHIVE_TABLES.map((s) => [s.table, s] as const))('%s — scope runs against the real schema', (table, spec) => {
    expect(() => db.prepare(`SELECT * FROM ${table} WHERE ${spec.scope}`).all('some-project-id'))
      .not.toThrow();
  });

  it.each(ARCHIVE_TABLES.map((s) => [s.table, s] as const))('%s — parents and rank are real columns', (table, spec) => {
    const cols = columnsOf(table);
    for (const parent of spec.parents) expect(cols, `${table}.${parent}`).toContain(parent);
    if (spec.rank) expect(cols, `${table}.${spec.rank}`).toContain(spec.rank);
  });

  it('covers every table that holds a writer’s work', () => {
    // Infrastructure and derived data are deliberately absent: op_log and
    // session_lock describe this installation, the FTS and mention tables are
    // caches rebuildable from what IS exported, and ai_run is a spend record
    // rather than the novel. Naming them here means a new table has to be
    // classified rather than silently forgotten.
    const exported = new Set(ARCHIVE_TABLES.map((s) => s.table));
    const notBackedUp = new Set([
      'op_log', 'session_lock', 'schema_migration', 'index_state',
      'scene_fts', 'codex_fts', 'mention', 'embedding',
      'ai_run', 'prompt_template', 'model_profile', 'provider_account', 'provider_policy',
      'law_violation', 'proposal', 'proposal_run', 'reference_source', 'reference_chunk',
      'calendar', 'timeline_event', 'timeline_event_entity', 'tag', 'tag_link',
      'narrative_thread_entity', 'entity_type',
    ]);
    const all = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '%_fts_%' AND name NOT LIKE '%_config' AND name NOT LIKE '%_data'
       AND name NOT LIKE '%_idx' AND name NOT LIKE '%_content' AND name NOT LIKE '%_docsize'`,
    ).all() as { name: string }[]).map((r) => r.name);

    const unclassified = all.filter((t) => !exported.has(t) && !notBackedUp.has(t));
    expect(unclassified, 'new tables must be classified as backed up or deliberately not').toEqual([]);
  });
});
