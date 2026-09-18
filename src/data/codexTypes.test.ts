import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { CodexRepository } from './codexRepository';

/** Types a project defines, and fields added to a type. Fixtures invented — D14. */

let driver: NodeSqlDriver;
let codex: CodexRepository;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  codex = new CodexRepository(driver);
  for (const id of ['p1', 'p2']) {
    await driver.query('INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', [id, id], 'run');
  }
});

describe('createType', () => {
  it('makes a project type from a label, lists it for that project only, and returns an existing key as it is', async () => {
    const made = await codex.createType('p1', ' Magic  Item ');
    expect(made).toMatchObject({ key: 'magic_item', label: 'Magic  Item'.trim(), attributes: [] });
    expect((await codex.listTypes('p1')).map((t) => t.key)).toContain('magic_item');
    expect((await codex.listTypes('p2')).map((t) => t.key)).not.toContain('magic_item');
    // Again: the same key, no second row.
    expect((await codex.createType('p1', 'magic item')).key).toBe('magic_item');
    expect((await driver.query("SELECT COUNT(*) FROM entity_type WHERE key LIKE 'magic_item%'", [], 'all')).rows).toEqual([[1]]);
    // A built-in is returned as it is.
    expect((await codex.createType('p1', 'Character')).key).toBe('character');
  });

  it('suffixes a key another project took, since keys are one namespace', async () => {
    await codex.createType('p1', 'Ship');
    const other = await codex.createType('p2', 'Ship');
    expect(other.key).toBe('ship_p2'.replace('p2', 'p2'));
    expect(other.key).not.toBe('ship');
    expect((await codex.listTypes('p2')).map((t) => t.key)).toContain(other.key);
    await expect(codex.createType('p1', '  ')).rejects.toThrow(/needs a name/);
  });
});

describe('addAttributeField', () => {
  it('adds a string field to the type\'s schema once, keeping the fields it had', async () => {
    const before = (await codex.listTypes('p1')).find((t) => t.key === 'character')!.attributes.map((a) => a.name);
    await codex.addAttributeField('character', ' Faction ');
    await codex.addAttributeField('character', 'faction');
    await codex.addAttributeField('character', 'backstory', true);
    const after = (await codex.listTypes('p1')).find((t) => t.key === 'character')!.attributes;
    expect(after.map((a) => a.name)).toEqual([...before, 'faction', 'backstory']);
    expect(after.find((a) => a.name === 'backstory')?.long).toBe(true);
    expect(after.find((a) => a.name === 'faction')?.label).toBe('Faction');
    await expect(codex.addAttributeField('nope', 'x')).rejects.toThrow(/no type/);
    await expect(codex.addAttributeField('character', '!!')).rejects.toThrow(/needs a name/);
  });

  it('works on a project type with an empty schema', async () => {
    const made = await codex.createType('p1', 'Ship');
    await codex.addAttributeField(made.key, 'tonnage');
    expect((await codex.listTypes('p1')).find((t) => t.key === made.key)!.attributes.map((a) => a.name)).toEqual(['tonnage']);
  });
});
