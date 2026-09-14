import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ManuscriptRepository } from './manuscriptRepository';
import { PlanRepository } from './planRepository';

/**
 * Arcs, beats, and which scenes carry them — against the real db/schema.sql.
 *
 * The claims worth proving are the ones the scene brief will depend on: that a
 * beat knows the scenes that realise it in reading order, that the many-to-many
 * really is many-to-many, and that the grid's two questions — which beats no
 * scene realises, which written scenes serve no beat — are answered by the gap
 * finder rather than by a second opinion written here.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let manuscript: ManuscriptRepository;
let repo: PlanRepository;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  manuscript = new ManuscriptRepository(driver);
  repo = new PlanRepository(driver);
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
});

/** A book of three scenes across two chapters, and one arc. */
async function book() {
  const b = await manuscript.createBook(PROJECT, 'Ashfall');
  const c1 = await manuscript.createChapter(b.id, 'Arrival');
  const c2 = await manuscript.createChapter(b.id, 'Departure');
  const scenes = [
    await manuscript.createScene(c1.id, 'The harbour'),
    await manuscript.createScene(c1.id, 'The gate'),
    await manuscript.createScene(c2.id, 'Last light'),
  ];
  const arc = await repo.createArc(b.id, 'Ilva takes the seal', 'main_plot');
  return { book: b, scenes, arc };
}

/** Give a scene prose, so it counts as written rather than merely planned. */
const write = (id: string, text: string) =>
  manuscript.saveSceneContent(id, { contentJson: null, contentText: text });

describe('arcs and beats', () => {
  it('creates an arc and beats in order under it', async () => {
    const { book: bk, arc } = await book();
    await repo.createBeat(arc.id, 'She is refused');
    await repo.createBeat(arc.id, 'She takes it anyway');

    expect((await repo.listBeats(bk.id)).map((b) => b.title))
      .toEqual(['She is refused', 'She takes it anyway']);
  });

  it('puts a beat where it was asked to go, not only at the end', async () => {
    const { book: bk, arc } = await book();
    const first = await repo.createBeat(arc.id, 'One');
    await repo.createBeat(arc.id, 'Three');
    await repo.createBeat(arc.id, 'Two', first.id);
    expect((await repo.listBeats(bk.id)).map((b) => b.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('writes only the fields a patch names', async () => {
    const { arc } = await book();
    const beat = await repo.createBeat(arc.id, 'A beat');
    await repo.updateBeat(beat.id, { summary: 'Kept', tension: 8 });
    await repo.updateBeat(beat.id, { function: 'midpoint' });

    const [back] = await repo.listBeats((await repo.listArcs(arc.bookId))[0]!.bookId);
    expect(back).toMatchObject({ summary: 'Kept', tension: 8, function: 'midpoint' });
  });

  it('takes an arc’s beats with it when the arc goes', async () => {
    // A beat has no life without an arc: `beat.arc_id` is NOT NULL, so leaving
    // them behind would leave rows that cannot be reached or re-parented.
    const { book: bk, arc } = await book();
    await repo.createBeat(arc.id, 'One');
    await repo.createBeat(arc.id, 'Two');
    await repo.removeArc(arc.id);

    expect(await repo.listArcs(bk.id)).toEqual([]);
    expect(await repo.listBeats(bk.id)).toEqual([]);
  });
});

describe('which scenes carry a beat', () => {
  it('is many-to-many, in reading order', async () => {
    // One beat set up early and paid off later; one scene serving two beats.
    const { book: bk, arc, scenes } = await book();
    const setup = await repo.createBeat(arc.id, 'The seal is shown');
    const payoff = await repo.createBeat(arc.id, 'The seal is taken');

    await repo.linkBeat(setup.id, scenes[2]!.id, 'echo');
    await repo.linkBeat(setup.id, scenes[0]!.id, 'setup');
    await repo.linkBeat(payoff.id, scenes[2]!.id, 'payoff');

    const beats = await repo.listBeats(bk.id);
    // Reading order, not the order they were linked in.
    expect(beats[0]!.sceneIds).toEqual([scenes[0]!.id, scenes[2]!.id]);
    expect(beats[1]!.sceneIds).toEqual([scenes[2]!.id]);
    expect((await repo.beatsForScene(scenes[2]!.id)).map((b) => `${b.title}/${b.role}`))
      .toEqual(['The seal is shown/echo', 'The seal is taken/payoff']);
  });

  it('changes the role rather than failing when a link is made twice', async () => {
    // The pair is the primary key, and pressing the same button twice is a
    // thing writers do.
    const { arc, scenes } = await book();
    const beat = await repo.createBeat(arc.id, 'A beat');
    await repo.linkBeat(beat.id, scenes[0]!.id, 'develop');
    await repo.linkBeat(beat.id, scenes[0]!.id, 'payoff');

    const links = await repo.beatsForScene(scenes[0]!.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.role).toBe('payoff');
  });

  it('unlinks without touching the beat', async () => {
    const { book: bk, arc, scenes } = await book();
    const beat = await repo.createBeat(arc.id, 'A beat');
    await repo.linkBeat(beat.id, scenes[0]!.id);
    await repo.unlinkBeat(beat.id, scenes[0]!.id);

    expect(await repo.beatsForScene(scenes[0]!.id)).toEqual([]);
    expect(await repo.listBeats(bk.id)).toHaveLength(1);
  });

  it('takes the links with a deleted beat', async () => {
    // A link to a deleted beat would make a scene look like it serves something
    // nobody is planning any more.
    const { arc, scenes } = await book();
    const beat = await repo.createBeat(arc.id, 'A beat');
    await repo.linkBeat(beat.id, scenes[0]!.id);
    await repo.removeBeat(beat.id);

    expect(await all('SELECT COUNT(*) FROM beat_scene')).toEqual([[0]]);
    expect(await repo.beatsForScene(scenes[0]!.id)).toEqual([]);
  });
});

describe('the matrix', () => {
  it('answers its two questions through the gap finder', async () => {
    // findGaps has been built and tested since Phase 0b with no caller. Its
    // rules for these two are exactly the grid's, so a second implementation
    // here would be a second opinion.
    const { book: bk, arc, scenes } = await book();
    const realised = await repo.createBeat(arc.id, 'Realised');
    await repo.createBeat(arc.id, 'Planned only');
    await write(scenes[0]!.id, 'The harbour was empty.');
    await write(scenes[1]!.id, 'She reached the gate.');
    await repo.linkBeat(realised.id, scenes[0]!.id);

    const { gaps } = await repo.matrix(bk.id);
    expect(gaps.map((g) => `${g.type}:${g.entityName}`)).toEqual([
      'orphan_scene:The gate',
      'unrealised_beat:Planned only',
    ]);
  });

  it('does not call an unwritten scene an orphan', async () => {
    // Unwritten is not orphaned — a scene nobody has started is not evidence of
    // a planning mistake.
    const { book: bk, arc, scenes } = await book();
    const beat = await repo.createBeat(arc.id, 'One');
    await repo.linkBeat(beat.id, scenes[0]!.id);
    await write(scenes[0]!.id, 'Written.');

    expect((await repo.matrix(bk.id)).gaps).toEqual([]);
  });

  it('returns the grid itself: scenes in reading order, beats under their arcs', async () => {
    const { book: bk, arc, scenes } = await book();
    await repo.createBeat(arc.id, 'One');
    const matrix = await repo.matrix(bk.id);

    expect(matrix.scenes.map((s) => s.title))
      .toEqual(['The harbour', 'The gate', 'Last light']);
    expect(matrix.scenes[0]!.chapterTitle).toBe('Arrival');
    expect(matrix.arcs).toHaveLength(1);
    expect(matrix.arcs[0]!.arc.name).toBe('Ilva takes the seal');
    expect(matrix.arcs[0]!.beats.map((b) => b.title)).toEqual(['One']);
    expect(scenes).toHaveLength(3);
  });
});
