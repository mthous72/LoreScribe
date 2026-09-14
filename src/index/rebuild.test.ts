import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { firstKey, initialKeys, sceneGlobalRank } from '../domain/sortKey';
import { indexStatus, markStale, REVISIONS } from './indexState';
import { rebuildAll, rebuildKind, rebuildPlan } from './rebuild';
import { restoreArchive } from '../data/backup';

/**
 * The rebuild path, run against the real db/schema.sql.
 *
 * Derived data lives in the same file as the novel, so the failure being tested
 * for is not "the index is wrong" — it is "the rebuild ate something it did not
 * write".
 */

const NOW = 1_760_000_000_000;
const PROJECT = 'p1';
const BOOK = 'b1';

let driver: NodeSqlDriver;

async function seed(): Promise<{
  sceneIds: string[]; chapterKeys: string[]; sceneKeys: string[]; bookKey: string;
}> {
  const bookKey = firstKey();
  const chapterKeys = initialKeys(2);
  const sceneKeys = initialKeys(2);
  const sceneIds = ['s1', 's2'];

  await driver.batch([
    { sql: 'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)', params: [PROJECT, 'Ashfall', NOW, NOW] },
    { sql: 'INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)', params: [BOOK, PROJECT, 'One', bookKey, NOW, NOW] },
    { sql: 'INSERT INTO chapter (id,book_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)', params: ['c1', BOOK, 'First', chapterKeys[0], NOW, NOW] },
    { sql: 'INSERT INTO chapter (id,book_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)', params: ['c2', BOOK, 'Second', chapterKeys[1], NOW, NOW] },
    { sql: 'INSERT INTO entity (id,project_id,type_key,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', params: ['e1', PROJECT, 'character', 'Ilva', 'A courier who reads.', NOW, NOW] },
    { sql: 'INSERT INTO entity (id,project_id,type_key,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', params: ['e2', PROJECT, 'location', 'The Long Hall', 'Where the council sits.', NOW, NOW] },
    { sql: 'INSERT INTO entity_alias (id,entity_id,alias,kind,created_at) VALUES (?,?,?,?,?)', params: ['a1', 'e1', 'Ilva', 'name', NOW] },
    { sql: 'INSERT INTO entity_alias (id,entity_id,alias,kind,created_at) VALUES (?,?,?,?,?)', params: ['a2', 'e2', 'The Long Hall', 'name', NOW] },
    // Deliberately WRONG ranks: this is what a rebuild is supposed to correct.
    { sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,pov_entity_id,content_text,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
    params: ['s1', 'c1', 'Arrival', sceneKeys[0], 'wrong-1', 'e1', 'Ilva came to The Long Hall. Ilva waited.', NOW, NOW] },
    { sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,content_text,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?)`,
    params: ['s2', 'c2', 'Departure', sceneKeys[1], 'wrong-2', 'The Long Hall emptied.', NOW, NOW] },
    { sql: 'INSERT INTO note (id,project_id,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)', params: ['n1', PROJECT, 'Check', 'Does the council meet at dawn?', NOW, NOW] },
  ], true);

  return { sceneIds, chapterKeys, sceneKeys, bookKey };
}

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

beforeEach(async () => { driver = await NodeSqlDriver.open(); await seed(); });

describe('a project that has never been indexed', () => {
  it('reports every kind as needing a rebuild, and says why', async () => {
    const status = await indexStatus(driver);
    expect(status.map((s) => s.kind)).toEqual(['rank', 'mention', 'fts', 'embedding']);
    expect(status.every((s) => s.needsRebuild)).toBe(true);
    expect(status.every((s) => s.reason === 'never built')).toBe(true);
  });
});

describe('rank', () => {
  it('recomputes global_rank from the keys above each scene', async () => {
    const { bookKey, chapterKeys, sceneKeys } = await (async () => {
      const rows = await all('SELECT sort_key FROM book WHERE id = ?', [BOOK]);
      const chap = await all('SELECT sort_key FROM chapter ORDER BY sort_key');
      const sc = await all('SELECT sort_key FROM scene ORDER BY sort_key');
      return {
        bookKey: String(rows[0]![0]),
        chapterKeys: chap.map((r) => String(r[0])),
        sceneKeys: sc.map((r) => String(r[0])),
      };
    })();

    await rebuildKind(driver, PROJECT, 'rank');
    const ranks = await all('SELECT id, global_rank FROM scene ORDER BY id');
    expect(ranks[0]![1])
      .toBe(sceneGlobalRank({ bookKey, chapterKey: chapterKeys[0]!, sceneKey: sceneKeys[0]! }));
    expect(ranks[1]![1])
      .toBe(sceneGlobalRank({ bookKey, chapterKey: chapterKeys[1]!, sceneKey: sceneKeys[1]! }));
    expect(String(ranks[0]![1]) < String(ranks[1]![1])).toBe(true);
  });

  it('does not bump rev — a derived value is not an edit the writer made', async () => {
    const before = await all('SELECT rev FROM scene ORDER BY id');
    await rebuildKind(driver, PROJECT, 'rank');
    expect(await all('SELECT rev FROM scene ORDER BY id')).toEqual(before);
  });

  it('is cheap the second time, because it writes only what moves', async () => {
    await rebuildKind(driver, PROJECT, 'rank');
    const before = await all('SELECT id, global_rank FROM scene ORDER BY id');
    const again = await rebuildKind(driver, PROJECT, 'rank');
    expect(again.error).toBeNull();
    expect(await all('SELECT id, global_rank FROM scene ORDER BY id')).toEqual(before);
  });
});

describe('mentions', () => {
  it('finds entities by their aliases and derives pov from the authored field', async () => {
    await rebuildAll(driver, PROJECT, ['rank', 'mention']);
    const rows = await all(
      'SELECT scene_id, entity_id, role, alias_used, method FROM mention ORDER BY scene_id, entity_id');
    expect(rows).toEqual([
      ['s1', 'e1', 'pov', 'Ilva', 'alias_match'],
      ['s1', 'e2', 'mentioned', 'The Long Hall', 'alias_match'],
      ['s2', 'e2', 'mentioned', 'The Long Hall', 'alias_match'],
    ]);
  });

  it('never destroys a mention the writer confirmed', async () => {
    await driver.query(
      `INSERT INTO mention (id,scene_id,entity_id,role,alias_used,method,confirmed,created_at)
       VALUES ('m-kept','s2','e1','focus','Ilva','alias_match',1,?)`, [NOW], 'run');
    await rebuildAll(driver, PROJECT, ['rank', 'mention']);
    const kept = await all("SELECT role, confirmed FROM mention WHERE id = 'm-kept'");
    expect(kept).toEqual([['focus', 1]]);
    // And it is not duplicated by a fresh derived row for the same pair.
    expect(await all("SELECT COUNT(*) FROM mention WHERE scene_id='s2' AND entity_id='e1'"))
      .toEqual([[1]]);
  });

  it('never destroys a mention the prose placed explicitly', async () => {
    await driver.query(
      `INSERT INTO mention (id,scene_id,entity_id,role,method,confirmed,created_at)
       VALUES ('m-explicit','s2','e1','present','explicit',0,?)`, [NOW], 'run');
    await rebuildAll(driver, PROJECT, ['rank', 'mention']);
    expect(await all("SELECT method FROM mention WHERE id = 'm-explicit'")).toEqual([['explicit']]);
  });

  it('replaces its own stale rows rather than piling up duplicates', async () => {
    await rebuildAll(driver, PROJECT, ['rank', 'mention']);
    const first = await all('SELECT COUNT(*) FROM mention');
    await rebuildAll(driver, PROJECT, ['rank', 'mention']);
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual(first);
  });

  it('honours an alias that is itself a spoiler', async () => {
    // "the Warden" only means Ilva from the second scene onward.
    await rebuildKind(driver, PROJECT, 'rank');
    const s2Rank = String((await all("SELECT global_rank FROM scene WHERE id='s2'"))[0]![0]);
    await driver.batch([
      { sql: 'INSERT INTO entity_alias (id,entity_id,alias,linkable_from_scene_id,created_at) VALUES (?,?,?,?,?)', params: ['a3', 'e1', 'the Warden', 's2', NOW] },
      { sql: "UPDATE scene SET content_text = 'the Warden turned away.' WHERE id = 's1'", params: [] },
      { sql: "UPDATE scene SET content_text = 'the Warden turned away.' WHERE id = 's2'", params: [] },
    ], true);
    expect(s2Rank).not.toBe('');

    await rebuildKind(driver, PROJECT, 'mention');
    const byScene = await all("SELECT scene_id FROM mention WHERE alias_used = 'the Warden'");
    expect(byScene.map((r) => r[0])).toEqual(['s2']);
  });
});

describe('full-text search', () => {
  it('indexes scenes, the codex and notes', async () => {
    await rebuildKind(driver, PROJECT, 'fts');
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'emptied'")).toEqual([['s2']]);
    expect(await all("SELECT owner_table, owner_id FROM codex_fts WHERE codex_fts MATCH 'courier'"))
      .toEqual([['entity', 'e1']]);
    expect(await all("SELECT owner_id FROM codex_fts WHERE codex_fts MATCH 'dawn'")).toEqual([['n1']]);
  });

  it('is idempotent — a second rebuild does not double every hit', async () => {
    await rebuildKind(driver, PROJECT, 'fts');
    const once = await all('SELECT COUNT(*) FROM scene_fts');
    await rebuildKind(driver, PROJECT, 'fts');
    expect(await all('SELECT COUNT(*) FROM scene_fts')).toEqual(once);
  });

  it('drops a deleted scene from the index', async () => {
    await driver.query("UPDATE scene SET deleted_at = ? WHERE id = 's2'", [NOW], 'run');
    await rebuildKind(driver, PROJECT, 'fts');
    expect(await all('SELECT scene_id FROM scene_fts')).toEqual([['s1']]);
  });
});

describe('index_state', () => {
  it('records the revision that built each kind, and clears the stale flag', async () => {
    await rebuildAll(driver, PROJECT);
    const status = await indexStatus(driver);
    const rank = status.find((s) => s.kind === 'rank')!;
    expect(rank.algoRevision).toBe(REVISIONS.rank);
    expect(rank.stale).toBe(false);
    expect(rank.needsRebuild).toBe(false);
    expect(rank.builtRows).toBe(2);
  });

  it('makes a bumped revision mean "stale" without touching a single row', async () => {
    await rebuildAll(driver, PROJECT, ['fts']);
    await driver.query("UPDATE index_state SET algo_revision = algo_revision - 1 WHERE kind = 'fts'", [], 'run');
    const fts = (await indexStatus(driver)).find((s) => s.kind === 'fts')!;
    expect(fts.needsRebuild).toBe(true);
    expect(fts.reason).toMatch(/older version of this feature/);
  });

  it('leaves a kind stale when its rebuild throws, with the reason attached', async () => {
    await rebuildAll(driver, PROJECT, ['rank']);
    await driver.exec('DROP TABLE mention');
    const outcome = await rebuildKind(driver, PROJECT, 'mention');
    expect(outcome.error).not.toBeNull();

    const mention = (await indexStatus(driver)).find((s) => s.kind === 'mention')!;
    expect(mention.stale).toBe(true);
    expect(mention.reason).toMatch(/the last rebuild failed/);
  });

  it('lets anything invalidate a kind without knowing how to rebuild it', async () => {
    await rebuildAll(driver, PROJECT, ['fts']);
    await markStale(driver, ['fts']);
    const fts = (await indexStatus(driver)).find((s) => s.kind === 'fts')!;
    expect(fts.needsRebuild).toBe(true);
    expect(fts.reason).toMatch(/out of date/);
  });
});

describe('a restore', () => {
  it('marks every derived kind stale, because the index describes the old data', async () => {
    await rebuildAll(driver, PROJECT);
    expect((await indexStatus(driver)).filter((s) => s.needsRebuild).map((s) => s.kind))
      .toEqual(['embedding']);                     // only the one with no rebuilder

    await restoreArchive(driver, [
      JSON.stringify({ kind: 'header', lorescribe: 1, exportedAt: NOW, schemaVersion: 2, projectId: PROJECT, projectTitle: 'Ashfall', counts: {} }),
      JSON.stringify({
        kind: 'row', table: 'scene', id: 's2', parents: { chapter_id: 'c2' }, hash: '',
        data: { id: 's2', chapter_id: 'c2', title: 'Departure, revised', sort_key: 'a1', global_rank: 'stale', content_text: 'Ilva left.', created_at: NOW, updated_at: NOW },
      }),
      JSON.stringify({ kind: 'footer', rows: 1, hash: '' }),
    ].join('\n'));

    expect((await indexStatus(driver)).every((s) => s.needsRebuild)).toBe(true);
  });
});

describe('what the settings button offers', () => {
  it('says plainly that semantic search cannot be built yet, rather than pretending', async () => {
    const plan = await rebuildPlan(driver);
    const embedding = plan.find((p) => p.kind === 'embedding')!;
    expect(embedding.unavailable).toMatch(/Phase 3/);

    const outcome = await rebuildKind(driver, PROJECT, 'embedding');
    expect(outcome.skipped).toBe(embedding.unavailable);
    // And it does NOT get marked built, because it was not.
    expect((await indexStatus(driver)).find((s) => s.kind === 'embedding')!.needsRebuild).toBe(true);
  });

  it('rebuilds ranks before mentions, because the spoiler rule reads ranks', async () => {
    const outcomes = await rebuildAll(driver, PROJECT);
    expect(outcomes.map((o) => o.kind)).toEqual(['rank', 'mention', 'fts', 'embedding']);
    expect(outcomes.filter((o) => o.error !== null)).toEqual([]);
  });
});
