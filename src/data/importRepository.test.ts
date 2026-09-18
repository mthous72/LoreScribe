import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { CodexRepository } from './codexRepository';
import { FactsRepository } from './factsRepository';
import { ManuscriptRepository } from './manuscriptRepository';
import { PlanRepository } from './planRepository';
import { ImportRepository, readKnowledgeCell, decisionKey } from './importRepository';
import { parseMarkdown } from '../import/markdown';
import type { Decisions } from './importRepository';

/**
 * Staging, applying and undoing an import, against the real db/schema.sql.
 *
 * The claims worth proving are the ones a writer is trusting when they drop two
 * hundred rows of their own world into a database: that nothing happened until
 * they said so, that a rejection shrinks the import rather than corrupting it,
 * and that the whole thing can come back out.
 *
 * Every fixture is invented — D14.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let codex: CodexRepository;
let facts: FactsRepository;
let repo: ImportRepository;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];
const count = async (table: string) =>
  Number((await all(`SELECT COUNT(*) FROM ${table} WHERE deleted_at IS NULL`))[0]![0]);

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  codex = new CodexRepository(driver);
  facts = new FactsRepository(driver);
  const manuscript = new ManuscriptRepository(driver);
  repo = new ImportRepository(driver, codex, facts, manuscript, new PlanRepository(driver));
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
});

const CHARACTER = '# Ilva\nShe keeps the seal.\n\n## Arc\nWant: the throne.\nLie: I am owed it.\n';
const TABLE = [
  '# Who knows what', '',
  '| Fact | Ilva | Renn |', '|---|---|---|',
  '| She is the heir | yes | no |',
  '| The seal is a fake | suspects | through the clerk |',
].join('\n');

/** Stage the given files with every node sent to the given destination. */
async function stage(files: Record<string, string>, decisions: Decisions) {
  const docs = Object.entries(files).map(([path, md]) => parseMarkdown(path, md));
  return repo.stage(PROJECT, docs, decisions);
}

describe('staging', () => {
  it('writes proposals and nothing else', async () => {
    // The property that makes the table worth having: a run that is never
    // applied is a run that changed nothing.
    const { proposals } = await stage({ 'characters/ilva.md': CHARACTER }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    expect(proposals).toBe(1);
    expect(await count('entity')).toBe(0);
    expect(Number((await all('SELECT COUNT(*) FROM proposal'))[0]![0])).toBe(1);
  });

  it('carries the nested template fields into the proposal', async () => {
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    const [only] = await repo.listProposals(runId);
    expect(only?.payload.attributes).toEqual({ want: 'the throne.', lie: 'I am owed it.' });
    expect(only?.rationale).toContain('characters/ilva.md');
  });

  it('turns a knowledge table into facts and who knows them', async () => {
    const { runId } = await stage({ 'reference/k.md': TABLE }, {
      [decisionKey('reference/k.md', '0')]: { kind: 'knowledge', factColumn: 0 },
    });
    const kinds = (await repo.listProposals(runId)).map((p) => p.targetTable);
    // Two facts; Ilva knows one and suspects the other, Renn learned one
    // through the clerk and does not know the other.
    expect(kinds.filter((k) => k === 'fact')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'fact_knowledge')).toHaveLength(3);
  });
});

describe('reading a cell of a who-knows-what table', () => {
  it('keeps the writer’s own words rather than storing a boolean', () => {
    // Cells say "through the guest" or "yes, but private". Throwing that away
    // would lose the more interesting half of what the table records.
    expect(readKnowledgeCell('through the clerk'))
      .toEqual({ belief: 'knows', learnedHow: 'through the clerk' });
    expect(readKnowledgeCell('yes')).toEqual({ belief: 'knows', learnedHow: null });
  });

  it('reads the beliefs that are not simply knowing', () => {
    expect(readKnowledgeCell('suspects')?.belief).toBe('suspects');
    expect(readKnowledgeCell('lied to')?.belief).toBe('believes_false');
    expect(readKnowledgeCell('denies')?.belief).toBe('denies');
  });

  it('says nothing at all for a no', () => {
    for (const cell of ['no', '-', '', '  ', '?', 'unknown']) {
      expect(readKnowledgeCell(cell), cell).toBeNull();
    }
  });
});

describe('applying', () => {
  async function stagedWorld() {
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER, 'reference/k.md': TABLE }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
      [decisionKey('reference/k.md', '0')]: { kind: 'knowledge', factColumn: 0 },
    });
    return runId;
  }

  it('creates nothing until the proposals are accepted', async () => {
    const runId = await stagedWorld();
    expect((await repo.apply(PROJECT, runId)).applied).toBe(0);
    expect(await count('entity')).toBe(0);
  });

  it('creates the entity with its dossier and its fields', async () => {
    const runId = await stagedWorld();
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);

    const [ilva] = await codex.listEntities(PROJECT, { search: 'Ilva' });
    expect(ilva?.name).toBe('Ilva');
    expect(ilva?.attributes).toEqual({ want: 'the throne.', lie: 'I am owed it.' });
    expect(ilva?.description).toContain('She keeps the seal.');
  });

  it('resolves who knows what by name, once the entities exist', async () => {
    // Entities before the facts about them, facts before who knows them.
    const runId = await stagedWorld();
    await repo.acceptAll(runId);
    const result = await repo.apply(PROJECT, runId);

    // Renn was never an entity. His "no" cell produced no proposal at all, so
    // exactly one row is left unresolvable — and it is reported rather than
    // silently dropped, because "212 applied" with no list gives a writer no
    // way to discover the ones that did not.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('Renn');

    const knowledge = await all(
      'SELECT e.name, k.belief FROM fact_knowledge k JOIN entity e ON e.id = k.entity_id');
    expect(knowledge).toEqual([['Ilva', 'knows'], ['Ilva', 'suspects']]);
  });

  it('updates an entity that already exists rather than minting a second one', async () => {
    // The default chosen for this importer: an exact name or alias match is an
    // update. Re-importing a corrected file must not give you two Ilvas.
    await codex.createEntity(PROJECT, { name: 'Ilva', typeKey: 'character', summary: 'The heir' });
    const runId = await stagedWorld();
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);

    expect(await count('entity')).toBe(1);
    const [ilva] = await codex.listEntities(PROJECT, { search: 'Ilva' });
    expect(ilva?.attributes.want).toBe('the throne.');
    // The import carried no summary, so what was there survives.
    expect(ilva?.summary).toBe('The heir');
  });

  it('matches an alias, not only the name', async () => {
    const created = await codex.createEntity(PROJECT, { name: 'Ilva Sarn', typeKey: 'character' });
    await codex.addAlias(created.id, 'Ilva');
    const runId = await stagedWorld();
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);
    expect(await count('entity')).toBe(1);
  });

  it('lets a rejection shrink the import rather than corrupt it', async () => {
    // Proposals refer to things by name, never by a minted id — so rejecting
    // the entity leaves the facts about it unresolvable and reported, not
    // pointing at a row that was never created.
    const runId = await stagedWorld();
    await repo.acceptAll(runId);
    const entityProposal = (await repo.listProposals(runId))
      .find((p) => p.targetTable === 'entity')!;
    await repo.setStatus([entityProposal.id], 'rejected');

    const result = await repo.apply(PROJECT, runId);
    expect(await count('entity')).toBe(0);
    expect(result.failed).toHaveLength(3);
    expect(await count('fact')).toBe(2);
  });
});

describe('taking it back', () => {
  it('abandons a staged run without touching anything', async () => {
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    await repo.abandon(runId);
    expect(await count('entity')).toBe(0);
    expect((await repo.listRuns(PROJECT))[0]?.status).toBe('abandoned');
  });

  it('undoes an applied run, creations and all', async () => {
    // A bad mapping writes two hundred rows, and "delete them by hand" is not
    // an answer.
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER, 'reference/k.md': TABLE }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
      [decisionKey('reference/k.md', '0')]: { kind: 'knowledge', factColumn: 0 },
    });
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);
    expect(await count('entity')).toBe(1);
    expect(await count('fact')).toBe(2);

    await repo.undo(runId);
    expect(await count('entity')).toBe(0);
    expect(await count('fact')).toBe(0);
    expect((await repo.listRuns(PROJECT))[0]?.status).toBe('undone');
  });

  it('puts back what an update overwrote', async () => {
    // The previous values are captured when the update is applied, because by
    // undo time the row has been overwritten and there is nothing left to
    // reconstruct them from.
    const before = await codex.createEntity(PROJECT, {
      name: 'Ilva', typeKey: 'character', summary: 'The heir', description: 'Original.',
    });
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);
    expect((await codex.getEntity(before.id))?.entity.description).toContain('keeps the seal');

    await repo.undo(runId);
    const restored = await codex.getEntity(before.id);
    expect(restored?.entity.description).toBe('Original.');
    expect(restored?.entity.attributes).toEqual({});
  });

  it('counts the runs a project has had, and what is in them', async () => {
    const { runId } = await stage({ 'characters/ilva.md': CHARACTER }, {
      [decisionKey('characters/ilva.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    expect((await repo.listRuns(PROJECT))[0]?.counts).toEqual({ pending: 1 });
    await repo.acceptAll(runId);
    expect((await repo.listRuns(PROJECT))[0]?.counts).toEqual({ accepted: 1 });
  });
});

describe('prose', () => {
  it('lands a scene in a named chapter rather than refusing for want of one', async () => {
    // A stated default, not a hidden one: a fresh project has no chapter to
    // choose, and refusing the import over that is worse than naming where it went.
    const { runId } = await stage({ 'scenes/one.md': '# Arrival\nThe harbour was empty.\n' }, {
      [decisionKey('scenes/one.md', '0')]: { kind: 'scene' },
    });
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);

    const scenes = await all(
      'SELECT s.title, s.content_text, c.title FROM scene s JOIN chapter c ON c.id = s.chapter_id');
    expect(scenes).toEqual([['Arrival', 'The harbour was empty.', 'Imported']]);
  });
});

describe('laws and the plan', () => {
  const HOUSE = '# House Style\n\n## House\n\n- No em dashes.  None.\n- Two spaces after a period.\n- Trust the reader.\n';
  const OUTLINE = [
    '# Outline', '', '## Movement 1. The door', '',
    '#### 1. Night 0 — written', '', 'She lets him in.', '', '1. He knocks twice.  She knows it.', '2. The price.', '',
    '#### 2. Wren — not written', '', '1. Wren counts.', '',
    '## Movement 2. The week', '',
    '#### 3. Old partner — not written', '', '1. They find her.', '',
  ].join('\n');

  it('applies a rule list as laws, one per bullet, and takes them back', async () => {
    const { runId } = await stage({ 'reference/house-style.md': HOUSE }, {
      [decisionKey('reference/house-style.md', '0')]: { kind: 'law', category: 'style' },
    });
    await repo.acceptAll(runId);
    const result = await repo.apply(PROJECT, runId);
    expect(result).toEqual({ applied: 3, failed: [] });
    const laws = await all(
      `SELECT category, severity, title, rule_text, scope_type, active FROM law
       WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_key`, [PROJECT]);
    expect(laws).toEqual([
      ['style', 'must', 'No em dashes', 'No em dashes.  None.', 'project', 1],
      ['style', 'must', 'Two spaces after a period', 'Two spaces after a period.', 'project', 1],
      ['style', 'must', 'Trust the reader', 'Trust the reader.', 'project', 1],
    ]);

    await repo.undo(runId);
    expect(await count('law')).toBe(0);
  });

  it('applies an outline as acts, planned scenes and linked beats, and takes it all back', async () => {
    const { runId, proposals } = await stage({ 'reference/outline.md': OUTLINE }, {
      [decisionKey('reference/outline.md', '0')]: { kind: 'plan' },
    });
    expect(proposals).toBe(1);
    await repo.acceptAll(runId);
    expect(await repo.apply(PROJECT, runId)).toEqual({ applied: 1, failed: [] });

    expect((await all('SELECT title FROM part WHERE deleted_at IS NULL ORDER BY sort_key')).flat())
      .toEqual(['The door', 'The week']);
    expect(await all(
      `SELECT c.number, c.title, p.title, s.status, s.summary FROM chapter c
       JOIN scene s ON s.chapter_id = c.id LEFT JOIN part p ON p.id = c.part_id
       WHERE c.deleted_at IS NULL ORDER BY c.sort_key`)).toEqual([
      [1, 'Night 0', 'The door', 'drafted', 'She lets him in.'],
      [2, 'Wren', 'The door', 'planned', null],
      [3, 'Old partner', 'The week', 'planned', null],
    ]);
    expect((await all('SELECT name FROM arc WHERE deleted_at IS NULL')).flat()).toEqual(['Outline']);
    // Every beat belongs to the outline's arc and is linked to its own scene.
    expect(await all(
      `SELECT b.title, b.summary, s.title FROM beat b
       JOIN beat_scene bs ON bs.beat_id = b.id JOIN scene s ON s.id = bs.scene_id
       WHERE b.deleted_at IS NULL ORDER BY b.sort_key`)).toEqual([
      ['He knocks twice', 'He knocks twice.  She knows it.', 'Night 0'],
      ['The price', null, 'Night 0'],
      ['Wren counts', null, 'Wren'],
      ['They find her', null, 'Old partner'],
    ]);

    await repo.undo(runId);
    for (const table of ['part', 'chapter', 'scene', 'arc', 'beat']) {
      expect(await count(table), table).toBe(0);
    }
  });

  it('splits a name from the description sharing its heading', async () => {
    const { runId } = await stage({ 'characters/wren.md': '# Wren, dock clerk, male\n\nHe counts.\n' }, {
      [decisionKey('characters/wren.md', '0')]: { kind: 'entity', typeKey: 'character' },
    });
    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);
    expect(await all('SELECT name, summary FROM entity WHERE deleted_at IS NULL'))
      .toEqual([['Wren', 'dock clerk, male']]);
  });

});

describe('prepared proposals — the extraction lane', () => {
  const prepared = (over: Partial<import('./importRepository').PreparedProposal> = {}) => ({
    table: 'entity', op: 'new' as const,
    payload: { name: 'Ilva', typeKey: 'character', summary: 'Keeper.', description: null, attributes: {} },
    rationale: 'from cast.md — the model read it as a character', confidence: 0.9,
    evidenceQuote: 'keeps the seal', evidenceVerified: true, ...over,
  });

  it('stages with confidence and evidence, and accept-all leaves the unverified pending', async () => {
    const { runId } = await repo.stagePrepared(PROJECT, [
      prepared(),
      prepared({ payload: { name: 'Maren', typeKey: 'character', summary: null, description: null, attributes: {} },
        evidenceQuote: 'Maren walked in', evidenceVerified: false, confidence: 0.95 }),
      prepared({ table: 'fact', payload: { key: 'k1', predicate: 'The seal is a fake.', statement: 'The seal is a fake.', subjectName: 'Ilva' } }),
    ]);
    const before = await repo.listProposals(runId);
    expect(before.map((p) => [p.status, p.evidenceVerified, p.confidence, p.evidenceQuote])).toEqual([
      ['pending', true, 0.9, 'keeps the seal'],
      ['pending', false, 0.95, 'Maren walked in'],
      ['pending', true, 0.9, 'keeps the seal'],
    ]);
    await repo.acceptAll(runId);
    const after = await repo.listProposals(runId);
    expect(after.map((p) => p.status)).toEqual(['accepted', 'pending', 'accepted']);

    // Applied: Ilva and her fact, with the fact's subject resolved by name; Maren untouched.
    const result = await repo.apply(PROJECT, runId);
    expect(result).toEqual({ applied: 2, failed: [] });
    expect(await count('entity')).toBe(1);
    const [fact] = await all('SELECT subject_entity_id, statement FROM fact');
    const ilva = (await all('SELECT id FROM entity'))[0]![0];
    expect(fact).toEqual([ilva, 'The seal is a fake.']);
    // A rule's proposals stage as verified: the payload is the source.
    const ruled = await repo.stage(PROJECT, [parseMarkdown('cast.md', CHARACTER)], { 'cast.md#0': { kind: 'entity', typeKey: 'character' } });
    const ruledRows = await repo.listProposals(ruled.runId);
    expect(ruledRows.every((p) => p.evidenceVerified && p.confidence === null)).toBe(true);
  });

  it('records which model call produced the run', async () => {
    await driver.query(
      `INSERT INTO ai_run (id, project_id, purpose, status, created_at)
       VALUES ('run-x', ?, 'extract', 'ok', 1)`,
      [PROJECT], 'run');
    const { runId } = await repo.stagePrepared(PROJECT, [prepared()], 'run-x');
    expect(await all('SELECT ai_run_id FROM proposal_run WHERE id = ?', [runId])).toEqual([['run-x']]);
  });

  it('lets a writer edit what the table allows, and nothing else', async () => {
    const { runId } = await repo.stagePrepared(PROJECT, [
      prepared(),
      prepared({ table: 'law', payload: { category: 'style', severity: 'must', title: 'x', ruleText: 'No adverbs.', order: 0 } }),
    ]);
    const [entity, law] = await repo.listProposals(runId);
    await repo.edit(entity!.id, { name: ' Ilva Vell ', summary: '' });
    await repo.edit(law!.id, { category: 'content', ruleText: 'No adverbs on dialogue tags.' });
    const [e2, l2] = await repo.listProposals(runId);
    expect(e2!.payload).toMatchObject({ name: 'Ilva Vell', summary: null, typeKey: 'character' });
    expect(l2!.payload).toMatchObject({ category: 'content', ruleText: 'No adverbs on dialogue tags.', title: 'x' });

    await expect(repo.edit(entity!.id, { attributes: {} })).rejects.toThrow(/not something an import can change/);
    await expect(repo.edit(entity!.id, { name: '  ' })).rejects.toThrow(/cannot be empty/);
    await expect(repo.edit('nope', { name: 'x' })).rejects.toThrow(/no such proposal/);

    await repo.acceptAll(runId);
    await repo.apply(PROJECT, runId);
    expect(await all('SELECT name FROM entity')).toEqual([['Ilva Vell']]);
    await expect(repo.edit(entity!.id, { name: 'Late' })).rejects.toThrow(/already been applied/);
  });

  it('applies a relationship between two staged entries by name, and undo takes it back', async () => {
    const entity = (name: string) => ({
      table: 'entity', op: 'new' as const, rationale: 'r',
      payload: { name, typeKey: 'character', summary: null, description: null, attributes: {} },
    });
    const { runId } = await repo.stagePrepared(PROJECT, [
      entity('Ilva'), entity('Renn'),
      { table: 'relationship', op: 'new', rationale: 'r', payload: { fromName: 'Renn', toName: 'Ilva', kind: 'serves', notes: 'He counts for her.' } },
      { table: 'relationship', op: 'new', rationale: 'r', payload: { fromName: 'Renn', toName: 'Nobody', kind: 'owes' } },
    ]);
    await repo.acceptAll(runId);
    const result = await repo.apply(PROJECT, runId);
    expect(result.applied).toBe(3);
    expect(result.failed.map((f) => f.reason)).toEqual(['no entity named "Nobody"']);
    const rows = await all('SELECT kind, notes FROM entity_relationship WHERE deleted_at IS NULL');
    expect(rows).toEqual([['serves', 'He counts for her.']]);
    await repo.undo(runId);
    expect(await all('SELECT COUNT(*) FROM entity_relationship WHERE deleted_at IS NULL')).toEqual([[0]]);
  });

  it('adds proposals to a staged run, accepting the verified ones, and refuses once it is applied', async () => {
    const { runId } = await repo.stagePrepared(PROJECT, [{
      table: 'entity', op: 'new', rationale: 'r',
      payload: { name: 'Ilva', typeKey: 'character', summary: null, description: null, attributes: {} },
    }]);
    await repo.acceptAll(runId);
    const added = await repo.addPrepared(runId, [
      { table: 'note', op: 'new', rationale: 'kept from a recommendation', payload: { title: 'The oath', body: 'verse' } },
      { table: 'entity', op: 'new', rationale: 'r', evidenceVerified: false,
        payload: { name: 'Maren', typeKey: 'character', summary: null, description: null, attributes: {} } },
    ]);
    expect(added).toBe(2);
    expect((await repo.listProposals(runId)).map((p) => [p.targetTable, p.status]))
      .toEqual([['entity', 'accepted'], ['note', 'accepted'], ['entity', 'pending']]);
    await expect(repo.addPrepared('nope', [])).rejects.toThrow(/no such import run/);
    await repo.apply(PROJECT, runId);
    await expect(repo.addPrepared(runId, [{ table: 'note', op: 'new', rationale: 'r', payload: { title: 'x', body: 'y' } }]))
      .rejects.toThrow(/already been applied/);
  });
});
