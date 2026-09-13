import { test, expect } from '@playwright/test';
import { gotoApp } from './support';
import { execFileSync } from 'node:child_process';

// Gate B. The conformance suite is the mechanism against R4: it is written
// against the SqlDriver interface, so Phase 6 is "make the Capacitor driver
// pass this" rather than "discover the abstraction was the wrong shape after
// there is real data". docs/15 §1.

test('B2 — the driver conformance suite', async ({ page }) => {
  await gotoApp(page, './');
  const cases = await page.evaluate(() => window.runConformance('lorescribe-conf'));

   
  console.log('\n' + cases.map((c) =>
    `${c.pass ? ' ✓ ' : ' ✗ '}${c.name}${c.detail ? `\n     ${c.detail}` : ''}`).join('\n'));

  expect(cases.length).toBeGreaterThanOrEqual(14);
  expect(cases.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
});

test('B3 — migration 001 produces exactly the schema db/schema.sql describes', async ({ page }) => {
  // Apply db/schema.sql with a completely independent SQLite (CPython's) and
  // compare what it creates against what the migration runner creates in
  // sqlite-wasm. This catches a runner that silently drops a view or a trigger,
  // and cross-validates two SQLite builds against each other.
  const expected: string[] = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3, json
c = sqlite3.connect(':memory:')
c.executescript(open('db/schema.sql').read())
rows = c.execute("""
  SELECT type || ' ' || name FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'
  ORDER BY type, name""").fetchall()
print(json.dumps([r[0] for r in rows]))
`]).toString());

  await gotoApp(page, './');
  const actual = await page.evaluate(() => window.schemaDump('lorescribe-dump'));

  expect(expected.length).toBeGreaterThan(50);
  expect(actual).toEqual(expected);
   
  console.log(`   ${actual.length} schema objects identical across CPython SQLite and sqlite-wasm`);
});

test('B4 — a database survives a close and reopen in every journal mode we ship', async ({ page }) => {
  // Regression guard for a bug that would have been catastrophic and silent:
  // a WAL database on opfs-sahpool could not be reopened AT ALL, failing with
  // SQLITE_CANTOPEN — which reads as "no such file" and means "you did not set
  // locking_mode=exclusive first". The writer's novel would have opened once and
  // never again. docs/16.
  await gotoApp(page, './');
  for (const mode of ['delete', 'wal'] as const) {
    const r = await page.evaluate((m) => window.reopenUnderJournalMode(`reopen-${m}`, m), mode);
    expect(r, `journal_mode=${mode} did not survive a reopen: ${JSON.stringify(r)}`)
      .toMatchObject({ ok: true, reopened: 'survived', journalOnReopen: mode });
  }
});

test('B5 — migration 002 seeds the entity types, and re-running changes nothing', async ({ page }) => {
  // entity.type_key references entity_type, and 001 ships no rows, so without
  // this a fresh database cannot hold a single entity. docs/16.
  await gotoApp(page, './');
  const state = await page.evaluate(() => window.migrationState('lorescribe-migstate')) as {
    firstApplied: number[]; secondApplied: number[]; userVersion: number;
    types: string[]; audit: string[];
  };

  expect(state.firstApplied).toEqual([1, 2]);
  expect(state.secondApplied, 'a second migrate() re-applied something').toEqual([]);
  expect(state.userVersion).toBe(2);
  expect(state.audit).toEqual(['1:init', '2:seed_entity_types']);
  expect(state.types).toEqual([
    'character', 'concept', 'event', 'faction', 'item', 'language',
    'location', 'motif', 'species', 'system', 'theme',
  ]);
});
