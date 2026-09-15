import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { LawsRepository } from './lawsRepository';

let driver: NodeSqlDriver;
let repo: LawsRepository;
const P = 'p1';

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  repo = new LawsRepository(driver);
  await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [P, 'P'], 'run');
});

describe('LawsRepository', () => {
  it('creates a project-scoped must by default, and lists it', async () => {
    const law = await repo.create(P, { title: 'No em dashes', ruleText: 'No em dashes. None.', category: 'style' });
    expect(law).toMatchObject({ scopeType: 'project', scopeId: null, severity: 'must', active: true, isSystem: false });
    expect((await repo.list(P)).map((l) => l.title)).toEqual(['No em dashes']);
  });

  it('refuses an empty title or rule', async () => {
    await expect(repo.create(P, { title: ' ', ruleText: 'x', category: 'style' })).rejects.toThrow(/title and a rule/);
  });

  it('orders must before should before prefer, then by title', async () => {
    await repo.create(P, { title: 'b', ruleText: 'r', category: 'style', severity: 'prefer' });
    await repo.create(P, { title: 'Z', ruleText: 'r', category: 'style', severity: 'must' });
    await repo.create(P, { title: 'a', ruleText: 'r', category: 'style', severity: 'should' });
    await repo.create(P, { title: 'A', ruleText: 'r', category: 'content', severity: 'must' });
    expect((await repo.list(P)).map((l) => `${l.severity}:${l.title}`))
      .toEqual(['must:A', 'must:Z', 'should:a', 'prefer:b']);
  });

  it('updates what it is given and nothing else, bumping rev', async () => {
    const law = await repo.create(P, { title: 't', ruleText: 'r', category: 'style' });
    await repo.update(law.id, { severity: 'should', examplesGood: 'like this', active: false });
    const after = await repo.get(law.id);
    expect(after).toMatchObject({
      title: 't', ruleText: 'r', severity: 'should', examplesGood: 'like this', active: false, rev: 2,
    });
  });

  it('scopes a law to a character, or to the point of view', async () => {
    await driver.query(
      'INSERT INTO entity (id, project_id, type_key, name, created_at, updated_at) '
      + "VALUES ('e1', ?, 'character', 'Ilva', 1, 1)",
      [P], 'run');
    const voice = await repo.create(P, {
      title: 'Clipped', ruleText: 'She does not explain.', category: 'voice', scopeType: 'pov', scopeId: 'e1',
    });
    expect(await repo.get(voice.id)).toMatchObject({ scopeType: 'pov', scopeId: 'e1' });
    await repo.update(voice.id, { scopeType: 'entity' });
    expect((await repo.get(voice.id))?.scopeType).toBe('entity');
  });

  it('soft-deletes, so the row is gone from the list but not from history', async () => {
    const law = await repo.create(P, { title: 't', ruleText: 'r', category: 'style' });
    await repo.remove(law.id);
    expect(await repo.list(P)).toEqual([]);
    expect(await repo.get(law.id)).toBeNull();
    const rows = (await driver.query('SELECT deleted_at FROM law WHERE id = ?', [law.id], 'all')).rows as number[][];
    expect(rows[0]![0]).toBeGreaterThan(0);
  });

  it('lists the hard floor and refuses to touch it', async () => {
    await driver.query(
      `INSERT INTO law (id, project_id, scope_type, category, severity, title, rule_text, is_system, active,
                        created_at, updated_at)
       VALUES ('floor', ?, 'project', 'content', 'must', 'The floor', 'Not this.', 1, 1, 1, 1)`, [P], 'run');
    expect((await repo.list(P)).map((l) => [l.title, l.isSystem])).toEqual([['The floor', true]]);
    await expect(repo.update('floor', { title: 'x' })).rejects.toThrow(/hard floor/);
    await expect(repo.remove('floor')).rejects.toThrow(/hard floor/);
    expect((await repo.get('floor'))?.title).toBe('The floor');
  });

  it('writes an op_log row for every change', async () => {
    const law = await repo.create(P, { title: 't', ruleText: 'r', category: 'style' });
    await repo.update(law.id, { title: 'u' });
    await repo.remove(law.id);
    const ops = (await driver.query(
      "SELECT op FROM op_log WHERE table_name = 'law' AND row_id = ? ORDER BY ts, rowid", [law.id], 'all')).rows;
    expect(ops.flat()).toEqual(['insert', 'update', 'delete']);
  });
});
