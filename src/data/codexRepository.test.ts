import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { CodexRepository, attributeFields } from './codexRepository';
import { ManuscriptRepository } from './manuscriptRepository';
import { indexStatus } from '../index/indexState';
import { rebuildKind } from '../index/rebuild';

/**
 * The codex, against the real db/schema.sql.
 *
 * The failures worth testing are the silent ones. An entity the prose cannot
 * see, a rename that stops detection, an alias edit that leaves every scene's
 * mentions describing the old alias list — none of these raise an error. They
 * just quietly stop working.
 */

const PROJECT = 'p1';
let driver: NodeSqlDriver;
let codex: CodexRepository;
let manuscript: ManuscriptRepository;

const all = async (sql: string, params: unknown[] = []) =>
  (await driver.query(sql, params, 'all')).rows as unknown[][];

beforeEach(async () => {
  driver = NodeSqlDriver.open();
  codex = new CodexRepository(driver);
  manuscript = new ManuscriptRepository(driver);
  await driver.query('INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    [PROJECT, 'Ashfall', 1, 1], 'run');
});

/** One chapter, one scene, with prose naming the entity under test. */
async function sceneSaying(text: string): Promise<string> {
  const book = await manuscript.createBook(PROJECT, 'One');
  const chapter = await manuscript.createChapter(book.id, 'First');
  const scene = await manuscript.createScene(chapter.id, 'Arrival');
  await manuscript.saveSceneContent(scene.id, { contentText: text });
  return scene.id;
}

describe('entity types', () => {
  it('offers the built-ins the schema seeds', async () => {
    const types = await codex.listTypes(PROJECT);
    expect(types.map((t) => t.key)).toContain('character');
    expect(types.map((t) => t.key)).toContain('location');
    expect(types).toHaveLength(11);
  });

  it('derives the editor fields from the type’s JSON Schema', async () => {
    // Migration 002 says a field added to the schema "appears in the UI without
    // code". That is only true if something reads it — this is that something.
    const character = (await codex.listTypes(PROJECT)).find((t) => t.key === 'character')!;
    const names = character.attributes.map((a) => a.name);
    expect(names).toContain('want');
    expect(names).toContain('voice_profile');
    expect(character.attributes.find((a) => a.name === 'voice_profile')!.long).toBe(true);
    expect(character.attributes.find((a) => a.name === 'want')!.long).toBe(false);
    expect(character.attributes.find((a) => a.name === 'voice_profile')!.label)
      .toBe('Voice profile');
  });

  it('costs the extra fields, not the type, when a schema is malformed', () => {
    expect(attributeFields('{ not json')).toEqual([]);
    expect(attributeFields(null)).toEqual([]);
  });
});

describe('creating an entity', () => {
  it('mints a primary alias from the name, or the prose could never see it', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva', typeKey: 'character' });
    const aliases = await codex.listAliases(ilva.id);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ alias: 'Ilva', isPrimary: true, autoLink: true });
  });

  it('is found by the matcher end to end', async () => {
    const scene = await sceneSaying('Ilva waited. Ilva left.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT scene_id, entity_id, role FROM mention'))
      .toEqual([[scene, ilva.id, 'present']]);
  });

  it('defaults the compliance fields to the honest answer', async () => {
    // docs/13: the hard floor reads these BEFORE a model call. "unknown" is
    // the truth about an entity nobody has classified; "adult" would be a guess
    // the floor would then act on.
    const e = await codex.createEntity(PROJECT, { name: 'Ilva' });
    expect(e.maturity).toBe('unknown');
    expect(e.isRealPerson).toBe(false);
    expect(await all('SELECT maturity, is_real_person FROM entity')).toEqual([['unknown', 0]]);
  });

  it('logs the entity and its alias, so a sync could replay the codex', async () => {
    await codex.createEntity(PROJECT, { name: 'Ilva' });
    expect((await all('SELECT table_name, op FROM op_log ORDER BY seq'))
      .map((r) => `${r[0]}/${r[1]}`))
      .toEqual(['entity/insert', 'entity_alias/insert']);
  });
});

describe('renaming', () => {
  it('carries the primary alias, or the rename silently stops detection', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await codex.updateEntity(ilva.id, { name: 'Ilva Renn' });
    expect((await codex.listAliases(ilva.id)).map((a) => a.alias)).toEqual(['Ilva Renn']);
  });

  it('leaves a hand-edited primary alias alone', async () => {
    // Once the writer has chosen it, it is theirs. Overwriting it would undo a
    // deliberate choice with no way to notice.
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    const primary = (await codex.listAliases(ilva.id))[0]!;
    await codex.updateAlias(primary.id, { alias: 'Ilv' });
    await codex.updateEntity(ilva.id, { name: 'Ilva Renn' });
    expect((await codex.listAliases(ilva.id)).map((a) => a.alias)).toEqual(['Ilv']);
  });
});

describe('aliases', () => {
  it('adds one and the matcher then finds it', async () => {
    const scene = await sceneSaying('The Warden turned away.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[0]]);

    await codex.addAlias(ilva.id, 'The Warden', { kind: 'epithet' });
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT scene_id, alias_used FROM mention'))
      .toEqual([[scene, 'The Warden']]);
  });

  it('respects an alias switched off, without deleting it', async () => {
    await sceneSaying('The Warden turned away.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    const alias = await codex.addAlias(ilva.id, 'The Warden');
    await codex.updateAlias(alias.id, { autoLink: false });
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[0]]);
    expect(await codex.listAliases(ilva.id)).toHaveLength(2);   // still there
  });

  it('marks mentions stale on every alias change', async () => {
    // Adding "the Warden" changes what the manuscript means, retroactively.
    // Nothing else in the system would notice.
    await sceneSaying('Ilva waited.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await rebuildKind(driver, PROJECT, 'mention');
    expect((await indexStatus(driver)).find((s) => s.kind === 'mention')!.needsRebuild)
      .toBe(false);

    const alias = await codex.addAlias(ilva.id, 'The Warden');
    expect((await indexStatus(driver)).find((s) => s.kind === 'mention')!.needsRebuild)
      .toBe(true);

    await rebuildKind(driver, PROJECT, 'mention');
    await codex.removeAlias(alias.id);
    expect((await indexStatus(driver)).find((s) => s.kind === 'mention')!.needsRebuild)
      .toBe(true);
  });
});

describe('searching', () => {
  it('finds an entity by an alias, not only by its name', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await codex.addAlias(ilva.id, 'The Grey Warden');
    await codex.createEntity(PROJECT, { name: 'The Long Hall', typeKey: 'location' });

    expect((await codex.listEntities(PROJECT, { search: 'Warden' })).map((e) => e.name))
      .toEqual(['Ilva']);
    expect((await codex.listEntities(PROJECT, { typeKey: 'location' })).map((e) => e.name))
      .toEqual(['The Long Hall']);
  });
});

describe('relationships', () => {
  it('reads from both ends, because it is a fact about both', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    const hall = await codex.createEntity(PROJECT, { name: 'The Long Hall', typeKey: 'location' });
    await codex.addRelationship(PROJECT, ilva.id, hall.id, 'serves', { strength: 3 });

    const fromIlva = (await codex.listRelationships(ilva.id))[0]!;
    expect(fromIlva).toMatchObject({ outgoing: true, otherName: 'The Long Hall', kind: 'serves' });
    const fromHall = (await codex.listRelationships(hall.id))[0]!;
    expect(fromHall).toMatchObject({ outgoing: false, otherName: 'Ilva', kind: 'serves' });
  });

  it('soft-deletes, so the tombstone can replicate', async () => {
    const a = await codex.createEntity(PROJECT, { name: 'Ilva' });
    const b = await codex.createEntity(PROJECT, { name: 'Renn' });
    const id = await codex.addRelationship(PROJECT, a.id, b.id, 'knows');
    await codex.removeRelationship(id);
    expect(await codex.listRelationships(a.id)).toEqual([]);
    expect(await all('SELECT COUNT(*) FROM entity_relationship')).toEqual([[1]]);
  });
});

describe('deleting an entity', () => {
  it('takes its mentions and aliases, but leaves a tombstone', async () => {
    await sceneSaying('Ilva waited. Ilva left.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[1]]);

    await codex.removeEntity(ilva.id);
    expect(await codex.listEntities(PROJECT)).toEqual([]);
    // Derived rows describing a link that no longer exists; every backlink
    // query would still return them.
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[0]]);
    expect(await all('SELECT COUNT(*) FROM entity_alias')).toEqual([[0]]);
    expect(await all('SELECT deleted_at IS NOT NULL FROM entity')).toEqual([[1]]);
  });

  it('does not come back when the index is rebuilt', async () => {
    await sceneSaying('Ilva waited. Ilva left.');
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva' });
    await codex.removeEntity(ilva.id);
    await rebuildKind(driver, PROJECT, 'mention');
    expect(await all('SELECT COUNT(*) FROM mention')).toEqual([[0]]);
  });
});
