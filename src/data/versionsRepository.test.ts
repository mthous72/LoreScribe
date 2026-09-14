import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ManuscriptRepository } from './manuscriptRepository';
import { VersionsRepository } from './versionsRepository';

/**
 * Kept drafts, against the real db/schema.sql.
 *
 * The claim under test is the one a writer is trusting when they press restore:
 * that what was on the page a moment ago is still somewhere. Everything else
 * here — labels, the parent chain, the word count — is bookkeeping around that.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let manuscript: ManuscriptRepository;
let repo: VersionsRepository;
let sceneId: string;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

/** Write prose the way the editor's autosave does. */
const write = (text: string) => manuscript.saveSceneContent(sceneId, {
  contentJson: JSON.stringify({
    type: 'doc',
    content: text.split('\n').map((p) => ({
      type: 'paragraph', content: p ? [{ type: 'text', text: p }] : [],
    })),
  }),
  contentText: text,
});

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  manuscript = new ManuscriptRepository(driver);
  repo = new VersionsRepository(driver, manuscript);
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
  const book = await manuscript.createBook(PROJECT, 'One');
  const chapter = await manuscript.createChapter(book.id, 'First');
  sceneId = (await manuscript.createScene(chapter.id, 'Arrival')).id;
});

describe('keeping a draft', () => {
  it('stores the prose, its word count and the origin it came from', async () => {
    await write('The harbour was empty when she arrived.');
    const { version, created } = await repo.snapshot(sceneId, { label: 'draft 1' });

    expect(created).toBe(true);
    expect(version).toMatchObject({ label: 'draft 1', origin: 'manual', wordCount: 7 });
    expect((await repo.get(version.id))?.contentText)
      .toBe('The harbour was empty when she arrived.');
    // The doc is kept too, not just the text: restoring into the editor needs
    // the marks, or every entity link in the scene would be lost on the way back.
    expect((await repo.get(version.id))?.contentJson).toContain('"type":"doc"');
  });

  it('refuses to pile up identical drafts', async () => {
    // Pressing "keep this version" twice is a thing writers do, and a list of
    // identical drafts is a list nobody can choose from.
    await write('Unchanged.');
    const first = await repo.snapshot(sceneId);
    const again = await repo.snapshot(sceneId);
    expect(again.created).toBe(false);
    expect(again.version.id).toBe(first.version.id);
    expect(await repo.list(sceneId)).toHaveLength(1);
  });

  it('keeps a second copy when the writer names it, even if the text has not moved', async () => {
    await write('Unchanged.');
    await repo.snapshot(sceneId);
    const named = await repo.snapshot(sceneId, { label: 'before the rewrite' });
    expect(named.created).toBe(true);
    expect(await repo.list(sceneId)).toHaveLength(2);
  });

  it('points each draft at the one it grew out of', async () => {
    await write('One.');
    const first = await repo.snapshot(sceneId);
    await write('Two.');
    const second = await repo.snapshot(sceneId);
    expect(second.version.parentVersionId).toBe(first.version.id);
    expect(first.version.parentVersionId).toBeNull();
  });

  it('marks exactly one draft as where the prose stands', async () => {
    await write('One.');
    await repo.snapshot(sceneId);
    await write('Two.');
    await repo.snapshot(sceneId);
    const active = (await repo.list(sceneId)).filter((v) => v.isActive);
    expect(active).toHaveLength(1);
    expect((await repo.get(active[0]!.id))?.contentText).toBe('Two.');
  });

  it('lists newest first', async () => {
    await write('One.');
    await repo.snapshot(sceneId, { label: 'a' });
    await write('Two.');
    await repo.snapshot(sceneId, { label: 'b' });
    expect((await repo.list(sceneId)).map((v) => v.label)).toEqual(['b', 'a']);
  });

  it('logs the prose, not merely the fact of a snapshot', async () => {
    await write('Something worth keeping.');
    await repo.snapshot(sceneId);
    const logged = await all(
      "SELECT payload FROM op_log WHERE table_name = 'scene_version' AND op = 'insert'");
    expect(String(logged[0]![0])).toContain('Something worth keeping.');
  });
});

describe('restoring', () => {
  it('puts the kept prose back on the page', async () => {
    await write('The first version.');
    const kept = await repo.snapshot(sceneId, { label: 'draft 1' });
    await write('A later version that went nowhere.');

    await repo.restore(PROJECT, kept.version.id);
    expect((await manuscript.getSceneContent(sceneId))?.contentText).toBe('The first version.');
  });

  it('keeps what was on the page before overwriting it', async () => {
    // The property the whole screen rests on: a writer who picked the wrong
    // draft out of a list has lost nothing, because the way back is in the list.
    await write('The first version.');
    const kept = await repo.snapshot(sceneId, { label: 'draft 1' });
    await write('The work in progress.');

    const { keptId } = await repo.restore(PROJECT, kept.version.id);
    expect(keptId).not.toBeNull();
    expect((await repo.get(keptId!))?.contentText).toBe('The work in progress.');
  });

  it('is itself undoable, by restoring the draft it kept', async () => {
    await write('The first version.');
    const kept = await repo.snapshot(sceneId, { label: 'draft 1' });
    await write('The work in progress.');

    const { keptId } = await repo.restore(PROJECT, kept.version.id);
    await repo.restore(PROJECT, keptId!);
    expect((await manuscript.getSceneContent(sceneId))?.contentText).toBe('The work in progress.');
  });

  it('moves the word count and the search index with the prose', async () => {
    // Restoring goes through the autosave's own write path precisely so these
    // follow without this repository knowing they exist.
    await write('One two three four five.');
    const kept = await repo.snapshot(sceneId);
    await write('Short.');

    const { wordCount } = await repo.restore(PROJECT, kept.version.id);
    expect(wordCount).toBe(5);
    expect(Number((await all('SELECT word_count FROM scene WHERE id = ?', [sceneId]))[0]![0]))
      .toBe(5);
    const found = await all(
      "SELECT COUNT(*) FROM scene_fts WHERE scene_fts MATCH 'three'");
    expect(Number(found[0]![0])).toBe(1);
  });

  it('makes the restored draft the one the prose now stands at', async () => {
    await write('One.');
    const kept = await repo.snapshot(sceneId);
    await write('Two.');
    await repo.restore(PROJECT, kept.version.id);

    const active = (await repo.list(sceneId)).filter((v) => v.isActive);
    expect(active.map((v) => v.id)).toEqual([kept.version.id]);
  });

  it('does not keep a redundant copy when the page has not moved', async () => {
    await write('One.');
    const kept = await repo.snapshot(sceneId);
    const { keptId } = await repo.restore(PROJECT, kept.version.id);
    expect(keptId).toBeNull();
    expect(await repo.list(sceneId)).toHaveLength(1);
  });
});

describe('labels and deletion', () => {
  it('renames a draft, and treats an empty name as no name', async () => {
    await write('One.');
    const { version } = await repo.snapshot(sceneId, { label: 'draft 1' });
    await repo.relabel(version.id, '  what if she stays  ');
    expect((await repo.list(sceneId))[0]!.label).toBe('what if she stays');
    await repo.relabel(version.id, '   ');
    expect((await repo.list(sceneId))[0]!.label).toBeNull();
  });

  it('deletes a draft without orphaning the ones that grew out of it', async () => {
    // The foreign key would refuse the delete outright; re-parenting is what
    // keeps the list a history rather than a heap with a hole in it.
    await write('One.');
    const a = await repo.snapshot(sceneId, { label: 'a' });
    await write('Two.');
    const b = await repo.snapshot(sceneId, { label: 'b' });
    await write('Three.');
    const c = await repo.snapshot(sceneId, { label: 'c' });
    expect(c.version.parentVersionId).toBe(b.version.id);

    await repo.remove(b.version.id);
    expect((await repo.list(sceneId)).map((v) => v.label)).toEqual(['c', 'a']);
    expect((await repo.list(sceneId))[0]!.parentVersionId).toBe(a.version.id);
  });

  it('is quiet about a draft that is already gone', async () => {
    await expect(repo.remove('nothing')).resolves.toBeUndefined();
  });

  it('survives the scene being deleted, because that delete is a soft one', async () => {
    // scene_version cascades on scene_id, but only on a HARD delete, and every
    // delete in the manuscript is a tombstone. So the drafts of a deleted scene
    // are still there — which is the behaviour that makes deleting a scene
    // recoverable, and is worth knowing deliberately rather than by accident.
    await write('One.');
    await repo.snapshot(sceneId);
    await manuscript.removeScene(sceneId);
    expect(await repo.list(sceneId)).toHaveLength(1);
  });
});
