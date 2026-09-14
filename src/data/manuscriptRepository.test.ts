import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ManuscriptRepository } from './manuscriptRepository';
import { isValidKey, isValidGlobalRank } from '../domain/sortKey';

/**
 * The manuscript repository, against the real db/schema.sql.
 *
 * The claims worth testing are not "insert works". They are the two properties
 * the UI is going to depend on and cannot check for itself: that a reorder
 * writes one row, and that derived data never lags the move that changed it.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let repo: ManuscriptRepository;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];
const opLog = async () =>
  (await all('SELECT table_name, row_id, op FROM op_log ORDER BY seq'))
    .map((r) => `${r[0]}/${r[2]}`);

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  repo = new ManuscriptRepository(driver);
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
});

/** A book with two chapters of two scenes each, in reading order. */
async function skeleton() {
  const book = await repo.createBook(PROJECT, 'One');
  const c1 = await repo.createChapter(book.id, 'First');
  const c2 = await repo.createChapter(book.id, 'Second');
  const scenes = [
    await repo.createScene(c1.id, 'A'),
    await repo.createScene(c1.id, 'B'),
    await repo.createScene(c2.id, 'C'),
    await repo.createScene(c2.id, 'D'),
  ];
  return { book, c1, c2, scenes };
}

describe('creating the tree', () => {
  it('appends to the end of the list by default', async () => {
    const { book, c1 } = await skeleton();
    expect((await repo.listChapters(book.id)).map((c) => c.title)).toEqual(['First', 'Second']);
    expect((await repo.listScenes(c1.id)).map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('gives every level a valid fractional key and every scene a real rank', async () => {
    const { book, scenes } = await skeleton();
    for (const c of await repo.listChapters(book.id)) expect(isValidKey(c.sortKey)).toBe(true);
    for (const s of scenes) {
      expect(isValidKey(s.sortKey), s.title!).toBe(true);
      expect(isValidGlobalRank(s.globalRank), `${s.title} rank ${s.globalRank}`).toBe(true);
    }
    // The rank is filled by the same transaction that inserts the scene; the
    // NOT NULL placeholder must never survive.
    expect(scenes.map((s) => s.globalRank)).not.toContain('');
  });

  it('puts a scene between two others when asked', async () => {
    const { c1, scenes } = await skeleton();
    const between = await repo.createScene(c1.id, 'A½', { afterId: scenes[0]!.id });
    expect((await repo.listScenes(c1.id)).map((s) => s.title)).toEqual(['A', 'A½', 'B']);
    expect(isValidKey(between.sortKey)).toBe(true);
  });

  it('logs every write, so a sync could replay the manuscript', async () => {
    await skeleton();
    expect(await opLog()).toEqual([
      'book/insert', 'chapter/insert', 'chapter/insert',
      'scene/insert', 'scene/insert', 'scene/insert', 'scene/insert',
    ]);
  });
});

describe('reordering', () => {
  it('writes one row for the scene that moved', async () => {
    const { c1, scenes } = await skeleton();
    const before = await all('SELECT id, sort_key, rev FROM scene ORDER BY id');

    await repo.moveScene(scenes[1]!.id, { beforeId: scenes[0]!.id });

    const after = await all('SELECT id, sort_key, rev FROM scene ORDER BY id');
    const changed = after.filter((r, i) => String(r[1]) !== String(before[i]![1]));
    expect(changed.map((r) => r[0])).toEqual([scenes[1]!.id]);
    expect((await repo.listScenes(c1.id)).map((s) => s.title)).toEqual(['B', 'A']);
  });

  it('keeps global_rank in step, so reading order follows immediately', async () => {
    const { book, scenes } = await skeleton();
    await repo.moveScene(scenes[3]!.id, { chapterId: scenes[0]!.chapterId, beforeId: scenes[0]!.id });
    expect((await repo.readingOrder(book.id)).map((s) => s.title)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('reorders a whole chapter of scenes by moving the chapter', async () => {
    const { book, c1, c2 } = await skeleton();
    await repo.moveChapter(c2.id, { beforeId: c1.id });
    expect((await repo.readingOrder(book.id)).map((s) => s.title)).toEqual(['C', 'D', 'A', 'B']);
    // And the scenes' own sort keys are untouched: only the derived rank moved.
    expect((await repo.listScenes(c1.id)).map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('does not bump rev for a rank the move merely recomputed', async () => {
    const { c1, c2, scenes } = await skeleton();
    const before = await all('SELECT id, rev FROM scene ORDER BY id');
    const { ranksChanged } = await repo.moveChapter(c2.id, { beforeId: c1.id });
    // Not vacuous, and minimal: only the moved chapter's own scenes get a new
    // rank. The other chapter's key did not move, so neither did its scenes'.
    expect(ranksChanged).toBe(2);
    expect(scenes).toHaveLength(4);
    const after = await all('SELECT id, rev FROM scene ORDER BY id');
    expect(after).toEqual(before);                 // every rank changed; no rev did
  });

  it('moves a scene into another chapter and fixes both chapters', async () => {
    const { c1, c2, scenes } = await skeleton();
    await repo.moveScene(scenes[0]!.id, { chapterId: c2.id });
    expect((await repo.listScenes(c1.id)).map((s) => s.title)).toEqual(['B']);
    expect((await repo.listScenes(c2.id)).map((s) => s.title)).toEqual(['C', 'D', 'A']);
  });

  it('survives being dragged into the same gap over and over', async () => {
    // Repeated inserts in one gap are what lengthen fractional keys. Correctness
    // must not depend on rebalancing having happened.
    const { c1, scenes } = await skeleton();
    for (let i = 0; i < 40; i++) {
      await repo.moveScene(scenes[1]!.id, { afterId: scenes[0]!.id });
      await repo.moveScene(scenes[1]!.id, { beforeId: scenes[0]!.id });
    }
    const order = await repo.listScenes(c1.id);
    expect(order.map((s) => s.title)).toEqual(['B', 'A']);
    expect(order.every((s) => isValidKey(s.sortKey))).toBe(true);
  });
});

describe('saving prose', () => {
  it('counts words with the project’s own counter, not split(" ")', async () => {
    const { scenes } = await skeleton();
    // An em dash splits words and a hyphen does not: 'rain—hard' is two,
    // 'well-lit' is one. split(' ') gets both wrong and would report 5.
    const { wordCount } = await repo.saveSceneContent(scenes[0]!.id, {
      contentText: 'The well-lit hall fell rain—hard.',
    });
    expect(wordCount).toBe(6);
    expect((await all('SELECT word_count FROM scene WHERE id = ?', [scenes[0]!.id]))[0])
      .toEqual([6]);
  });

  it('keeps search in step with the prose in the same transaction', async () => {
    const { scenes } = await skeleton();
    await repo.saveSceneContent(scenes[0]!.id, { contentText: 'The council met at dawn.' });
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'council'"))
      .toEqual([[scenes[0]!.id]]);

    await repo.saveSceneContent(scenes[0]!.id, { contentText: 'The hall stood empty.' });
    // The old text is gone, not merely joined by the new — the failure mode is
    // search results for prose the writer deleted.
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'council'")).toEqual([]);
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'empty'"))
      .toEqual([[scenes[0]!.id]]);
  });

  it('follows a rename into the index too', async () => {
    const { scenes } = await skeleton();
    await repo.renameScene(scenes[0]!.id, 'The Long Hall');
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'Hall'"))
      .toEqual([[scenes[0]!.id]]);
  });

  it('re-detects mentions only when asked, through the shared rules', async () => {
    const { scenes } = await skeleton();
    await driver.batch([
      { sql: `INSERT INTO entity (id,project_id,type_key,name,created_at,updated_at)
              VALUES ('e1',?,'character','Ilva',1,1)`, params: [PROJECT] },
      { sql: `INSERT INTO entity_alias (id,entity_id,alias,created_at)
              VALUES ('a1','e1','Ilva',1)`, params: [] },
    ], true);

    await repo.saveSceneContent(scenes[0]!.id, { contentText: 'Ilva waited. Ilva left.' });
    // An autosave does not touch mentions — they churn mid-word.
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[0]]);

    await repo.reindexScene(PROJECT, scenes[0]!.id);
    expect(await all('SELECT entity_id, role FROM mention')).toEqual([['e1', 'present']]);
  });
});

describe('deleting', () => {
  it('soft-deletes a scene and takes its derived rows with it', async () => {
    const { scenes } = await skeleton();
    await repo.saveSceneContent(scenes[0]!.id, { contentText: 'The council met at dawn.' });
    await repo.removeScene(scenes[0]!.id);

    expect((await repo.listScenes(scenes[0]!.chapterId)).map((s) => s.title)).toEqual(['B']);
    // The row survives as a tombstone a sync can replicate...
    expect(await all('SELECT deleted_at IS NOT NULL FROM scene WHERE id = ?', [scenes[0]!.id]))
      .toEqual([[1]]);
    // ...but search must not still find prose the writer deleted.
    expect(await all("SELECT scene_id FROM scene_fts WHERE scene_fts MATCH 'council'")).toEqual([]);
  });

  it('cascades a chapter delete to its scenes, logging each one', async () => {
    const { c1 } = await skeleton();
    await repo.removeChapter(c1.id);
    expect(await repo.listScenes(c1.id)).toEqual([]);
    // A sync that replayed only "chapter deleted" would leave the scenes behind
    // on the other device.
    const deletes = (await opLog()).filter((e) => e.endsWith('/delete'));
    expect(deletes).toEqual(['scene/delete', 'scene/delete', 'chapter/delete']);
  });

  it('keeps the chapters when a part is removed', async () => {
    const { book, c1, c2 } = await skeleton();
    const part = await repo.createPart(book.id, 'Act One');
    await repo.moveChapter(c1.id, { partId: part.id });
    await repo.moveChapter(c2.id, { partId: part.id });

    await repo.removePart(part.id);
    // A part groups chapters that already existed. Deleting "Act One" must not
    // delete the chapters in it.
    expect((await repo.listChapters(book.id)).map((c) => c.title)).toEqual(['First', 'Second']);
    expect((await repo.listChapters(book.id)).every((c) => c.partId === null)).toBe(true);
    expect((await repo.readingOrder(book.id)).map((s) => s.title)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('makes a repeat delete a no-op rather than a second tombstone', async () => {
    const { scenes } = await skeleton();
    await repo.removeScene(scenes[0]!.id);
    const rev = await all('SELECT rev FROM scene WHERE id = ?', [scenes[0]!.id]);
    await repo.removeScene(scenes[0]!.id);
    expect(await all('SELECT rev FROM scene WHERE id = ?', [scenes[0]!.id])).toEqual(rev);
  });
});

describe('the authored metadata a scene brief will read', () => {
  it('writes only the fields it was given, and leaves the rest alone', async () => {
    // Doc 08's "merges never destroy", applied to a form: a panel that knows
    // about four fields must not be able to blank the other four.
    const { scenes } = await skeleton();
    const id = scenes[0]!.id;
    await repo.updateScene(id, { purpose: 'Get her through the gate.', tension: 7 });
    await repo.updateScene(id, { tense: 'past' });

    const details = await repo.getSceneDetails(id);
    expect(details).toMatchObject({
      purpose: 'Get her through the gate.', tension: 7, tense: 'past',
    });
  });

  it('records a POV character, which is what the pov mention is derived from', async () => {
    const { scenes } = await skeleton();
    await driver.query(
      `INSERT INTO entity (id,project_id,type_key,name,created_at,updated_at)
       VALUES ('e1',?, 'character','Ilva',1,1)`, [PROJECT], 'run');
    await repo.updateScene(scenes[0]!.id, { povEntityId: 'e1' });
    expect((await repo.getSceneDetails(scenes[0]!.id))?.povEntityId).toBe('e1');
  });

  it('can clear a field that was set, without clearing its neighbours', async () => {
    const { scenes } = await skeleton();
    const id = scenes[0]!.id;
    await repo.updateScene(id, { purpose: 'Something', summary: 'Kept' });
    await repo.updateScene(id, { purpose: null });

    const details = await repo.getSceneDetails(id);
    expect(details?.purpose).toBeNull();
    expect(details?.summary).toBe('Kept');
  });

  it('does nothing at all when given nothing', async () => {
    const { scenes } = await skeleton();
    const before = Number((await all('SELECT rev FROM scene WHERE id = ?', [scenes[0]!.id]))[0]![0]);
    await repo.updateScene(scenes[0]!.id, {});
    expect(Number((await all('SELECT rev FROM scene WHERE id = ?', [scenes[0]!.id]))[0]![0]))
      .toBe(before);
  });

  it('logs the change, and moves a renamed title into search', async () => {
    const { scenes } = await skeleton();
    await repo.updateScene(scenes[0]!.id, { title: 'The harbour', summary: 'Not searchable' });
    expect(await opLog()).toContain('scene/update');

    const hits = await all("SELECT title FROM scene_fts WHERE scene_fts MATCH 'harbour'");
    expect(hits).toEqual([['The harbour']]);
    // A summary is authored shorthand: searching a word should find the scene
    // that contains it, not the one whose note mentions it.
    expect(await all("SELECT COUNT(*) FROM scene_fts WHERE scene_fts MATCH 'searchable'"))
      .toEqual([[0]]);
  });
});
