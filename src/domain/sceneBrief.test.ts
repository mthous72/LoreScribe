import { describe, it, expect } from 'vitest';
import { seedBrief, type EntityRow, type SeedInput } from './sceneBrief';

/**
 * Step 1 of the compiler.
 *
 * The clause under test is one sentence of doc 03 — *weighted by the mention's
 * role in this scene rather than by book-level importance* — and it is easy to
 * read past. Weighting by `entity.importance` instead hands the model a full
 * dossier on someone who is not in the room and a sentence about the person
 * whose eyes the scene is told through, which is how a big-context dump behaves.
 *
 * The other half is where POV and location come from. `mention` is a cache,
 * rebuilt on an idle timer; the scene row is authored. A brief compiled a second
 * after the POV changed has to be right about it.
 */

const entity = (id: string, over: Partial<EntityRow> = {}): EntityRow => ({
  id, name: id, typeKey: 'character', importance: 'minor',
  summary: `${id}, in one line.`, description: `${id}, at length.`, ...over,
});

const input = (over: Partial<SeedInput> = {}): SeedInput => ({
  scene: {
    id: 's1', title: 'The harbour', globalRank: 'a1a1a1', purpose: 'Get her through.',
    summary: null, povEntityId: null, povMode: 'close_third', tense: 'past',
    locationEntityId: null, wordCount: 900,
  },
  mentions: [],
  entities: new Map(),
  beats: [],
  ...over,
});

const world = (...ids: string[]) => new Map(ids.map((id) => [id, entity(id)]));

describe('depth comes from the role in this scene', () => {
  it('gives the point of view everything and a passing mention one line', () => {
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      mentions: [{ entityId: 'Renn', role: 'mentioned' }],
      entities: world('Ilva', 'Renn'),
    }));
    expect(seed.cast.map((c) => `${c.name}:${c.depth}`))
      .toEqual(['Ilva:full', 'Renn:name-only']);
  });

  it('ignores book-level importance entirely', () => {
    // A protagonist merely named in passing gets one line; a background clerk
    // who is the point of view gets everything. This is the whole clause.
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'clerk' },
      mentions: [{ entityId: 'hero', role: 'mentioned' }],
      entities: new Map([
        ['clerk', entity('clerk', { importance: 'background' })],
        ['hero', entity('hero', { importance: 'protagonist' })],
      ]),
    }));
    expect(seed.cast.find((c) => c.name === 'hero')?.depth).toBe('name-only');
    expect(seed.cast.find((c) => c.name === 'clerk')?.depth).toBe('full');
  });

  it('maps every role doc 03 names', () => {
    const seed = seedBrief(input({
      mentions: [
        { entityId: 'a', role: 'focus' }, { entityId: 'b', role: 'present' },
        { entityId: 'c', role: 'mentioned' },
      ],
      entities: world('a', 'b', 'c'),
    }));
    expect(seed.cast.map((c) => c.depth)).toEqual(['full', 'standard', 'name-only']);
  });

  it('treats a role it does not recognise as the weakest one', () => {
    // Forward compatibility in the safe direction: a role added later must not
    // silently promote somebody to a full dossier.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'a', role: 'lurking' }],
      entities: world('a'),
    }));
    expect(seed.cast[0]).toMatchObject({ role: 'mentioned', depth: 'name-only' });
  });
});

describe('the authored columns outrank the cache', () => {
  it('carries the POV even when the mention index has not caught up', () => {
    // `mention` is rebuilt on an idle timer while a writer types. The scene row
    // is authored and cannot be stale, so a brief compiled a second after the
    // POV changed is still right about whose eyes it is written through.
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      mentions: [],
      entities: world('Ilva'),
    }));
    expect(seed.cast).toHaveLength(1);
    expect(seed.cast[0]).toMatchObject({ name: 'Ilva', role: 'pov', via: 'pov' });
    expect(seed.scene.povEntityName).toBe('Ilva');
  });

  it('does not let a stale mention demote the authored POV', () => {
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      mentions: [{ entityId: 'Ilva', role: 'mentioned' }],
      entities: world('Ilva'),
    }));
    expect(seed.cast[0]).toMatchObject({ role: 'pov', depth: 'full' });
  });

  it('puts the location in the setting, not the cast', () => {
    // Where, not who. A place named in the prose must not also be listed as a
    // character who was standing there.
    const seed = seedBrief(input({
      scene: { ...input().scene, locationEntityId: 'Harbour' },
      mentions: [{ entityId: 'Harbour', role: 'present' }],
      entities: new Map([['Harbour', entity('Harbour', { typeKey: 'location' })]]),
    }));
    expect(seed.cast).toEqual([]);
    expect(seed.setting.map((s) => s.name)).toEqual(['Harbour']);
    expect(seed.scene.locationName).toBe('Harbour');
  });
});

describe('what it refuses to guess at', () => {
  it('names an entity it could not resolve rather than dropping it', () => {
    // A brief that silently omits the POV because the row did not come back
    // looks identical to a scene with no POV, and nobody could tell which.
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'gone' },
      mentions: [{ entityId: 'also-gone', role: 'present' }],
      entities: new Map(),
    }));
    expect(seed.cast).toEqual([]);
    expect(seed.unresolved).toEqual([
      { kind: 'pov', id: 'gone' },
      { kind: 'entity', id: 'also-gone' },
    ]);
  });

  it('says a scene has no beats rather than pretending otherwise', () => {
    // Empty is a real answer here, and a loud one: it means the compiler has no
    // target, which is what D29 is about.
    expect(seedBrief(input()).beats).toEqual([]);
  });
});

describe('shape', () => {
  it('keeps one entity once, at its strongest role', () => {
    const seed = seedBrief(input({
      mentions: [
        { entityId: 'a', role: 'present' },
        { entityId: 'a', role: 'focus' },
        { entityId: 'a', role: 'mentioned' },
      ],
      entities: world('a'),
    }));
    expect(seed.cast).toHaveLength(1);
    expect(seed.cast[0]?.role).toBe('focus');
  });

  it('orders by role, then by name', () => {
    const seed = seedBrief(input({
      mentions: [
        { entityId: 'Zed', role: 'present' }, { entityId: 'Ann', role: 'present' },
        { entityId: 'Mia', role: 'focus' },
      ],
      entities: world('Zed', 'Ann', 'Mia'),
    }));
    expect(seed.cast.map((c) => c.name)).toEqual(['Mia', 'Ann', 'Zed']);
  });

  it('carries each beat with the arc it is a step of', () => {
    const seed = seedBrief(input({
      beats: [{
        beatId: 'b1', title: 'She is asked directly', summary: 'And does not answer.',
        function: 'turn', tension: 7, role: 'payoff',
        arcId: 'arc1', arcName: 'Who moved the seal', arcKind: 'mystery',
      }],
    }));
    expect(seed.beats[0]).toMatchObject({
      title: 'She is asked directly', role: 'payoff',
      arcName: 'Who moved the seal', arcKind: 'mystery',
    });
  });

  it('passes the scene’s own facts through untouched', () => {
    const seed = seedBrief(input());
    expect(seed.scene).toMatchObject({
      id: 's1', purpose: 'Get her through.', povMode: 'close_third',
      tense: 'past', globalRank: 'a1a1a1', wordCount: 900,
    });
  });
});
