import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ManuscriptRepository } from './manuscriptRepository';
import { PlanRepository } from './planRepository';
import { CodexRepository } from './codexRepository';
import { FactsRepository } from './factsRepository';
import { ImportRepository, decisionKey } from './importRepository';
import { ExportRepository } from './exportRepository';
import { parseMarkdown } from '../import/markdown';
import { readZipEntry } from '../import/docx';
import { suggestAll } from '../import/plan';
import type { Decisions } from './importRepository';
import type { SourceDoc } from '../import/source';

/**
 * The readable export, against the real schema.
 *
 * The centre of this file is the round trip. Every other assertion is about the
 * shape of a file; that one is about the claim the README makes to whoever
 * opens the folder in five years — that LoreScribe reads it back. A format the
 * app can only write is a lock-in with a download button, and the only way to
 * know it reads is to read it.
 *
 * Fixtures invented — D14.
 */

const PROJECT = 'p1';
const OTHER = 'p2';
let driver: NodeSqlDriver;
let manuscript: ManuscriptRepository;
let codex: CodexRepository;
let facts: FactsRepository;
let imports: ImportRepository;
let repo: ExportRepository;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  manuscript = new ManuscriptRepository(driver);
  codex = new CodexRepository(driver);
  facts = new FactsRepository(driver);
  imports = new ImportRepository(driver, codex, facts, manuscript, new PlanRepository(driver));
  repo = new ExportRepository(driver);
  for (const id of [PROJECT, OTHER]) {
    await driver.query(
      'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
      [id, 'Ashfall', 1, 1], 'run');
  }
});

/** A small world: two chapters of prose, two characters, one fact they share. */
async function world() {
  const book = await manuscript.createBook(PROJECT, 'Ashfall');
  const c1 = await manuscript.createChapter(book.id, 'Arrival');
  const c2 = await manuscript.createChapter(book.id, 'Departure');
  const s1 = await manuscript.createScene(c1.id, 'The harbour');
  await manuscript.saveSceneContent(s1.id, {
    contentJson: null, contentText: 'The harbour was empty when she arrived.',
  });
  await manuscript.createScene(c2.id, 'Last light');

  const ilva = await codex.createEntity(PROJECT, {
    name: 'Ilva', typeKey: 'character', summary: 'The heir who waits.',
    description: 'She keeps the seal.', attributes: { want: 'the throne.' },
  });
  await codex.addAlias(ilva.id, 'Ilva Sarn');
  const renn = await codex.createEntity(PROJECT, {
    name: 'Renn', typeKey: 'character', description: 'He counts the crates.',
  });
  const harbour = await codex.createEntity(PROJECT, {
    name: 'The harbour', typeKey: 'location', description: 'Empty at dawn.',
  });

  const fact = await facts.createFact(PROJECT, {
    predicate: 'is the heir', statement: 'Ilva is the heir', subjectEntityId: ilva.id,
  });
  await facts.setKnowledge(fact, ilva.id, { belief: 'knows' });
  await facts.setKnowledge(fact, renn.id, { belief: 'suspects', learnedHow: 'from the clerk' });
  return { ilva, renn, harbour, fact };
}

const paths = (entries: { path: string }[]) => entries.map((e) => e.path).sort();
const contentOf = (entries: { path: string; content: string | Uint8Array }[], path: string) =>
  String(entries.find((e) => e.path === path)?.content ?? '');

describe('gathering', () => {
  it('reads the whole book in reading order, in one query', async () => {
    await world();
    const [book] = await repo.books(PROJECT);
    expect(book?.title).toBe('Ashfall');
    expect(book?.parts[0]?.chapters.map((c) => c.title)).toEqual(['Arrival', 'Departure']);
    expect(book?.parts[0]?.chapters[0]?.scenes[0]?.contentText)
      .toBe('The harbour was empty when she arrived.');
  });

  it('keeps a chapter that has no scenes yet', async () => {
    // It joins as a row of nulls, which is a real chapter with nothing in it
    // rather than a row to throw away.
    const book = await manuscript.createBook(PROJECT, 'Ashfall');
    await manuscript.createChapter(book.id, 'Empty');
    const [only] = await repo.books(PROJECT);
    expect(only?.parts[0]?.chapters).toEqual([{ title: 'Empty', scenes: [] }]);
  });

  it('survives an attributes column that will not parse', async () => {
    // The export runs when a writer is worried about losing their work, which
    // is the worst possible moment to throw on one malformed column.
    const e = await codex.createEntity(PROJECT, { name: 'Ilva', typeKey: 'character' });
    await driver.query('UPDATE entity SET attributes = ? WHERE id = ?', ['not json', e.id], 'run');
    expect((await repo.entities(PROJECT))[0]?.attributes).toEqual({});
  });
});

describe('the bundle', () => {
  it('lays out a folder per kind and a file per thing', async () => {
    await world();
    const entries = await repo.bundle(PROJECT, 'Ashfall');
    expect(paths(entries)).toEqual([
      'README.md',
      'characters/ilva.md',
      'characters/renn.md',
      'locations/the-harbour.md',
      'manuscript/ashfall.md',
      'manuscript/ashfall.txt',
      'reference/knowledge.md',
    ]);
  });

  it('tells whoever opens it what does and does not come back', async () => {
    // The README is the only thing standing between a reader in five years and
    // a wrong assumption about what they are holding.
    const readme = contentOf(await repo.bundle(PROJECT, 'Ashfall'), 'README.md');
    expect(readme).toContain('readable');
    expect(readme).toContain('.lorescribe');
    expect(readme).toMatch(/does \*\*not\*\* come back/u);
  });

  it('leaves the knowledge file out when there are no facts', async () => {
    await manuscript.createBook(PROJECT, 'Ashfall');
    expect(paths(await repo.bundle(PROJECT, 'Ashfall'))).not.toContain('reference/knowledge.md');
  });

  it('zips into something the reader can open again', async () => {
    await world();
    const bytes = await repo.zip(PROJECT, 'Ashfall');
    const back = await readZipEntry(bytes, 'characters/ilva.md');
    expect(new TextDecoder().decode(back!)).toContain('# Ilva');
  });
});

describe('the round trip', () => {
  /** Read the bundle back the way the import screen would. */
  async function reimport(entries: { path: string; content: string | Uint8Array }[]) {
    const docs: SourceDoc[] = entries
      .filter((e) => e.path.endsWith('.md') && e.path !== 'README.md')
      .map((e) => parseMarkdown(e.path, String(e.content)));
    const types = await codex.listTypes(OTHER);
    const suggestions = suggestAll(docs, {
      existing: new Map(), types: new Set(types.map((t) => t.key)),
    });
    const decisions: Decisions = {};
    for (const s of suggestions) decisions[decisionKey(s.docPath, s.nodeId)] = s.destination;
    const { runId } = await imports.stage(OTHER, docs, decisions);
    await imports.acceptAll(runId);
    return { result: await imports.apply(OTHER, runId), suggestions };
  }

  it('brings the characters back, with the writer’s own fields', async () => {
    await world();
    await reimport(await repo.bundle(PROJECT, 'Ashfall'));

    const back = await codex.listEntities(OTHER);
    expect(back.map((e) => e.name).sort()).toEqual(['Ilva', 'Renn', 'The harbour']);
    const ilva = back.find((e) => e.name === 'Ilva')!;
    expect(ilva.typeKey).toBe('character');
    // The attribute a writer invented survives a trip out to a text file and
    // back, which is the part of the claim that is easy to get wrong.
    expect(ilva.attributes.want).toBe('the throne.');
    expect(back.find((e) => e.name === 'The harbour')?.typeKey).toBe('location');
  });

  it('brings the table of who knows what back', async () => {
    await world();
    await reimport(await repo.bundle(PROJECT, 'Ashfall'));

    const restored = await facts.listFacts(OTHER);
    expect(restored.map((f) => f.statement)).toEqual(['Ilva is the heir']);
    const knowledge = (await driver.query(
      `SELECT e.name, k.belief FROM fact_knowledge k
       JOIN entity e ON e.id = k.entity_id
       JOIN fact f ON f.id = k.fact_id
       WHERE f.project_id = ? ORDER BY e.name`, [OTHER], 'all')).rows as unknown[][];
    // Renn suspects, and learned it from the clerk. Both survive: the belief
    // word leads the cell so the importer can read it, and the note follows.
    // Writing only the note — the first version of this — brought `suspects`
    // back as plain knowing, losing the distinction the column exists for.
    expect(knowledge).toEqual([['Ilva', 'knows'], ['Renn', 'suspects']]);
  });

  it('applies every proposal it makes, with nothing left unresolved', async () => {
    // The strongest form of the claim: not merely that the files parse, but
    // that the whole bundle goes in without one row failing to resolve.
    await world();
    const { result } = await reimport(await repo.bundle(PROJECT, 'Ashfall'));
    expect(result.failed).toEqual([]);
    expect(result.applied).toBeGreaterThan(0);
  });

  it('recognises each folder without a marker left for itself', async () => {
    // characters/ilva.md comes back as a character because it sits in
    // characters/, through the same rule that reads a bible written by hand.
    await world();
    const { suggestions } = await reimport(await repo.bundle(PROJECT, 'Ashfall'));
    const ilva = suggestions.find((s) => s.docPath === 'characters/ilva.md');
    expect(ilva?.destination).toEqual({ kind: 'entity', typeKey: 'character' });
    expect(ilva?.reason).toContain('names a character');
  });

  it('does not lose a name that two entries share', async () => {
    await codex.createEntity(PROJECT, { name: 'Cal', typeKey: 'character', description: 'One.' });
    await codex.createEntity(PROJECT, { name: 'Cal', typeKey: 'character', description: 'Two.' });
    const entries = await repo.bundle(PROJECT, 'Ashfall');
    expect(paths(entries)).toContain('characters/cal.md');
    expect(paths(entries)).toContain('characters/cal-2.md');
  });
});
