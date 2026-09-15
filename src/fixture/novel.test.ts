import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { FactsRepository } from '../data/factsRepository';
import { PlanRepository } from '../data/planRepository';
import {
  factVisibilityAt, isKnowing, negativeConstraints, type FactForVisibility,
} from '../domain/factVisibility';
import { buildFixture, FIXTURE, type Fixture } from './novel';

/**
 * The fixture novel, proved to discriminate.
 *
 * This is the point of the file it tests. Doc 08's Phase 2 bar is a comparison —
 * a scene drafted at chapter 30 respects a chapter-2 fact and does not leak a
 * chapter-40 reveal, *and a control fails at least one of those* — and a fixture
 * that does not actually produce those conditions makes the comparison green and
 * meaningless. So each planted fact is checked here for the branch of the
 * spoiler rule it exists to make fire, before Phase 2 relies on any of it.
 *
 * Generated from a seed, never committed. D14 holds by construction.
 */

let driver: NodeSqlDriver;
let fixture: Fixture;
let facts: FactsRepository;
let plan: PlanRepository;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  facts = new FactsRepository(driver);
  plan = new PlanRepository(driver);
  fixture = await buildFixture(driver);
});

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

/** Every fact in the shape the spoiler rule takes, knowledge included. */
async function forVisibility(): Promise<FactForVisibility[]> {
  const rows = await facts.listFacts(fixture.projectId);
  const knowledge = await facts.knowledgeFor(rows.map((f) => f.id));
  return rows.map((f) => ({
    ...f,
    knownFrom: Object.fromEntries(
      (knowledge.get(f.id) ?? [])
        .filter((k) => isKnowing(k.belief))
        .map((k) => [k.entityId, k.knownFromRank])),
  }));
}

const statusAt = async (povEntityId?: string) => {
  const list = await forVisibility();
  const seen = factVisibilityAt(list, fixture.anchors.targetSceneRank, { povEntityId });
  return { list, seen, of: (id: string) => seen.get(id)?.status };
};

describe('the manuscript it builds', () => {
  it('is long enough for the comparison to mean anything', async () => {
    // The reveal is in chapter 40 and the drafting happens at 30, so a shorter
    // book would put the "does not leak" half of the bar in the past.
    expect(fixture.scenesByChapter).toHaveLength(FIXTURE.chapters);
    expect(FIXTURE.chapters).toBeGreaterThan(40);
    expect(await all('SELECT COUNT(*) FROM scene')).toEqual([
      [FIXTURE.chapters * FIXTURE.scenesPerChapter],
    ]);
  });

  it('gives every scene the metadata a brief is compiled from', async () => {
    const thin = await all(
      `SELECT COUNT(*) FROM scene
       WHERE pov_entity_id IS NULL OR purpose IS NULL OR summary IS NULL
          OR content_text IS NULL OR word_count = 0`);
    expect(thin).toEqual([[0]]);
  });

  it('ranks scenes in reading order, which is what the rule compares', async () => {
    const ranks = (await all('SELECT global_rank FROM scene ORDER BY global_rank'))
      .map((r) => String(r[0]));
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('plants beats, including two from different arcs on the target scene', async () => {
    // A scene serving one beat is the easy case; the brief has to handle the other.
    const beats = await plan.beatsForScene(fixture.anchors.targetSceneId);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(new Set(beats.map((b) => b.arcId)).size).toBeGreaterThan(1);
    expect((await plan.listArcs(fixture.bookId))).toHaveLength(3);
  });

  it('is the same manuscript every time, from the same seed', async () => {
    const second = await NodeSqlDriver.open();
    const twin = await buildFixture(second);
    expect(twin.anchors).toEqual(fixture.anchors);
    const text = async (d: NodeSqlDriver) =>
      (await d.query('SELECT content_text FROM scene ORDER BY global_rank', [], 'all')).rows;
    expect(await text(second)).toEqual(await text(driver));
  });
});

describe('what the spoiler rule says at chapter 30 — the whole point', () => {
  it('lets through the fact established and told in chapter 2', async () => {
    const { of } = await statusAt(fixture.anchors.povEntityId);
    expect(of(fixture.anchors.earlyFactId)).toBe('reader-knows');
  });

  it('withholds the chapter-40 reveal, and names it as a thing to keep back', async () => {
    // Silence is not enough — doc 03 §4. The heavy secret has to be named as
    // forbidden, or a model confabulates into the gap.
    const { list, seen, of } = await statusAt(fixture.anchors.povEntityId);
    expect(of(fixture.anchors.lateRevealFactId)).toBe('withheld');
    expect(negativeConstraints(list, seen).map((f) => f.id))
      .toContain(fixture.anchors.lateRevealFactId);
  });

  it('marks what the POV knows and the reader does not', async () => {
    // The branch that was dead in the real app until a scene could have a POV.
    const { of } = await statusAt(fixture.anchors.povEntityId);
    expect(of(fixture.anchors.povSecretFactId)).toBe('pov-knows');
  });

  it('hides that same fact from a different point of view', async () => {
    const other = Object.values(fixture.entities)
      .find((id) => id !== fixture.anchors.povEntityId)!;
    const { of } = await statusAt(other);
    expect(of(fixture.anchors.povSecretFactId)).toBe('withheld');
  });

  it('drops what stopped being true in chapter 20', async () => {
    const { of } = await statusAt(fixture.anchors.povEntityId);
    expect(of(fixture.anchors.invalidatedFactId)).toBe('invalidated');
  });

  it('drops what a later fact replaced', async () => {
    const { of } = await statusAt(fixture.anchors.povEntityId);
    expect(of(fixture.anchors.supersededFactId)).toBe('superseded');
  });

  it('produces all five outcomes at once, which is what makes it an instrument', async () => {
    // Any one of these could be got right by accident. A fixture where all five
    // fire from one reading position is one a control can actually fail.
    const { of } = await statusAt(fixture.anchors.povEntityId);
    const a = fixture.anchors;
    expect([
      of(a.earlyFactId), of(a.lateRevealFactId), of(a.povSecretFactId),
      of(a.invalidatedFactId), of(a.supersededFactId),
    ]).toEqual(['reader-knows', 'withheld', 'pov-knows', 'invalidated', 'superseded']);
  });
});

describe('the derived data a brief is seeded from', () => {
  it('has mentions, built by the real rebuilder rather than inserted by hand', async () => {
    // Step 1 of the compiler seeds the brief from `mention` rows. A fixture
    // without them has no cast and every dossier comes out empty — and building
    // them through the rebuilder means the fixture cannot drift from what the
    // app itself would derive.
    const total = Number((await all('SELECT COUNT(*) FROM mention'))[0]![0]);
    expect(total).toBeGreaterThan(FIXTURE.chapters);
  });

  it('gives the target scene a POV mention and a cast to draw dossiers from', async () => {
    const roles = await all(
      'SELECT role, COUNT(*) FROM mention WHERE scene_id = ? GROUP BY role',
      [fixture.anchors.targetSceneId]);
    const byRole = Object.fromEntries(roles.map((r) => [String(r[0]), Number(r[1])]));
    expect(byRole.pov).toBe(1);
    expect(Object.values(byRole).reduce((a, b) => a + b, 0)).toBeGreaterThan(1);
  });

  it('is searchable, so the semantic and FTS paths have something to find', async () => {
    const hits = await all("SELECT COUNT(*) FROM scene_fts WHERE scene_fts MATCH 'ledger'");
    expect(Number(hits[0]![0])).toBeGreaterThan(0);
  });
});
