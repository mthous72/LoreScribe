import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { FactsRepository, composeStatement } from './factsRepository';
import { CodexRepository } from './codexRepository';
import { ManuscriptRepository } from './manuscriptRepository';
import { SearchRepository } from './searchRepository';
import { factVisibilityAt } from '../domain/factVisibility';

/**
 * Facts against the real db/schema.sql.
 *
 * The spoiler rule itself is tested exhaustively and purely in
 * `src/domain/factVisibility.test.ts`. What these check is the wiring: that the
 * ranks reaching that rule are the manuscript's real ones, and that they follow
 * a scene when it moves.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let facts: FactsRepository;
let codex: CodexRepository;
let manuscript: ManuscriptRepository;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  facts = new FactsRepository(driver);
  codex = new CodexRepository(driver);
  manuscript = new ManuscriptRepository(driver);
  await driver.query('INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
});

/** Three scenes in reading order, and two characters. */
async function book() {
  const b = await manuscript.createBook(PROJECT, 'One');
  const c1 = await manuscript.createChapter(b.id, 'First');
  const c2 = await manuscript.createChapter(b.id, 'Second');
  const s1 = await manuscript.createScene(c1.id, 'Arrival');
  const s2 = await manuscript.createScene(c1.id, 'The Hall');
  const s3 = await manuscript.createScene(c2.id, 'Departure');
  const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
  const renn = await codex.createEntity(PROJECT, { name: 'Renn' });
  return { b, c1, c2, s1, s2, s3, ilva, renn };
}

describe('recording a fact', () => {
  it('composes a readable statement from the parts', async () => {
    const { ilva } = await book();
    const id = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the courier',
    });
    const [fact] = await facts.listFacts(PROJECT);
    expect(fact!.id).toBe(id);
    expect(fact!.statement).toBe('Ilva is the courier');
    expect(composeStatement(null, 'It rains', null)).toBe('It rains');
  });

  it('keeps a statement the writer wrote instead', async () => {
    const { ilva } = await book();
    await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the courier',
      statement: 'Nobody knows Ilva carries the seal.',
    });
    expect((await facts.listFacts(PROJECT))[0]!.statement)
      .toBe('Nobody knows Ilva carries the seal.');
  });

  it('is searchable at once, with no rebuild', async () => {
    const { ilva } = await book();
    await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'carries', objectText: 'the seal of office',
    });
    const search = new SearchRepository(driver);
    expect((await search.search(PROJECT, 'seal')).hits.map((h) => h.kind)).toEqual(['fact']);
  });
});

describe('the ranks that reach the spoiler rule', () => {
  it('come from the scenes the writer chose', async () => {
    const { ilva, s1, s3 } = await book();
    await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the heir',
      establishedSceneId: s1.id, revealedSceneId: s3.id, spoilerWeight: 3,
    });
    const [fact] = await facts.listFacts(PROJECT);

    expect(factVisibilityAt([fact!], s1.globalRank).get(fact!.id)!.status).toBe('withheld');
    expect(factVisibilityAt([fact!], s3.globalRank).get(fact!.id)!.status).toBe('reader-knows');
  });

  it('follow a scene when it is moved in the tree', async () => {
    // The reveal is in the last scene. Drag that scene to the front and the
    // reader now learns it first — without this record knowing anything about
    // the tree, because rank is what it stores.
    const { ilva, s1, s3, c1 } = await book();
    await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the heir',
      revealedSceneId: s3.id,
    });
    const before = (await facts.listFacts(PROJECT))[0]!;
    expect(factVisibilityAt([before], s1.globalRank).get(before.id)!.status).toBe('withheld');

    await manuscript.moveScene(s3.id, { chapterId: c1.id, beforeId: s1.id });
    const after = (await facts.listFacts(PROJECT))[0]!;
    const s1Rank = String((await all('SELECT global_rank FROM scene WHERE id = ?', [s1.id]))[0]![0]);
    expect(factVisibilityAt([after], s1Rank).get(after.id)!.status).toBe('reader-knows');
  });
});

describe('who knows what', () => {
  it('lets the POV character know something the reader does not', async () => {
    const { ilva, renn, s1, s3 } = await book();
    const id = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the heir',
      revealedSceneId: s3.id,
    });
    await facts.setKnowledge(id, ilva.id, { knownFromSceneId: s1.id, learnedHow: 'She was told.' });

    const [fact] = await facts.listFacts(PROJECT);
    expect(factVisibilityAt([fact!], s1.globalRank, { povEntityId: ilva.id }).get(id)!.status)
      .toBe('pov-knows');
    expect(factVisibilityAt([fact!], s1.globalRank, { povEntityId: renn.id }).get(id)!.status)
      .toBe('withheld');
  });

  it('does not treat being lied to as knowing', async () => {
    // believes_false is the opposite of knowledge, and counting it would let
    // the rule reveal a fact to the character who has been deceived about it.
    const { ilva, s1, s3 } = await book();
    const id = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'is', objectText: 'the heir',
      revealedSceneId: s3.id,
    });
    await facts.setKnowledge(id, ilva.id, { belief: 'believes_false', knownFromSceneId: s1.id });

    const [fact] = await facts.listFacts(PROJECT);
    expect(factVisibilityAt([fact!], s1.globalRank, { povEntityId: ilva.id }).get(id)!.status)
      .toBe('withheld');
  });

  it('edits a belief rather than recording a second opinion', async () => {
    const { ilva } = await book();
    const id = await facts.createFact(PROJECT, { subjectEntityId: ilva.id, predicate: 'is' });
    await facts.setKnowledge(id, ilva.id, { belief: 'suspects' });
    await facts.setKnowledge(id, ilva.id, { belief: 'knows' });

    const rows = (await facts.knowledgeFor([id])).get(id)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.belief).toBe('knows');

    await facts.removeKnowledge(id, ilva.id);
    expect((await facts.knowledgeFor([id])).get(id)).toBeUndefined();
  });
});

describe('contradictions', () => {
  it('finds two active facts that disagree about the same thing', async () => {
    const { ilva } = await book();
    const a = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'eye colour', objectText: 'grey',
    });
    const b = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'eye colour', objectText: 'green',
    });
    const found = await facts.conflicts(PROJECT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subjectEntityId: ilva.id, predicate: 'eye colour' });
    // As a pair, not in an order. The view orders its two columns by id to
    // report each clash once, and two facts recorded in the same millisecond
    // get UUIDv7s whose random tails sort either way — so asserting which is
    // "first" is a coin flip, and it landed tails once before this comment.
    expect([found[0]!.factA, found[0]!.factB].sort()).toEqual([a, b].sort());
  });

  it('says nothing when they agree, or when one is retired', async () => {
    const { ilva, s2 } = await book();
    await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'eye colour', objectText: 'grey',
    });
    const b = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'eye colour', objectText: 'grey',
    });
    expect(await facts.conflicts(PROJECT)).toEqual([]);

    await facts.updateFact(b, { objectText: 'green', invalidatedSceneId: s2.id });
    expect(await facts.conflicts(PROJECT)).toEqual([]);
  });
});

describe('deleting', () => {
  it('leaves a tombstone and drops it out of search', async () => {
    const { ilva } = await book();
    const id = await facts.createFact(PROJECT, {
      subjectEntityId: ilva.id, predicate: 'carries', objectText: 'the seal of office',
    });
    const search = new SearchRepository(driver);
    expect((await search.search(PROJECT, 'seal')).hits).toHaveLength(1);

    await facts.removeFact(id);
    expect(await facts.listFacts(PROJECT)).toEqual([]);
    expect((await search.search(PROJECT, 'seal')).hits).toEqual([]);
    expect(await all('SELECT deleted_at IS NOT NULL FROM fact')).toEqual([[1]]);
  });
});
