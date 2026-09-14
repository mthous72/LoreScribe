import { describe, it, expect } from 'vitest';
import {
  expandOneHop, seedBrief,
  type BeatRow, type EntityRow, type RelationshipRow, type SeedInput,
} from './sceneBrief';

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

/* ------------------------------------------------- step 2: expand one hop */

/**
 * Step 2 has one number in it and everything turns on that number. *One hop,
 * not two — two-hop expansion pulls in the whole world and defeats the
 * purpose.* A test suite that only checked that neighbours arrive would pass
 * just as happily against a full transitive closure, so most of what follows is
 * about what does **not** come back: the relationship that has not started, the
 * one that has ended, the secret one, and the stranger two steps away that no
 * beat asked for.
 */

const rel = (from: string, to: string, over: Partial<RelationshipRow> = {}): RelationshipRow => ({
  fromEntityId: from, toEntityId: to, kind: 'family', label: 'sister of',
  strength: 3, isSecret: false, sinceRank: null, untilRank: null, ...over,
});

const beat = (title: string, summary: string | null = null): BeatRow => ({
  beatId: `b-${title}`, title, summary, function: null, tension: null,
  role: 'develop', arcId: 'arc1', arcName: 'The seal', arcKind: 'main_plot',
});

/** A seed with `ids` present, then one hop out of it at the scene's rank. */
const expand = (
  seed: ReturnType<typeof seedBrief>,
  relationships: RelationshipRow[],
  worldIds: string[],
  aliases?: Map<string, string[]>,
) => expandOneHop({
  seed, atRank: seed.scene.globalRank, relationships,
  entities: world(...worldIds), aliases,
});

describe('one hop out of the scene', () => {
  it('brings a neighbour in as a line, not as a member of the scene', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(seed, [rel('Ilva', 'Renn')], ['Ilva', 'Renn']);

    expect(out.cast.find((c) => c.name === 'Renn')).toMatchObject({
      role: 'mentioned', depth: 'name-only', via: 'relationship',
    });
    expect(out.links).toEqual([{
      fromEntityId: 'Ilva', toEntityId: 'Renn', kind: 'family',
      label: 'sister of', strength: 3, hop: 1,
    }]);
  });

  it('reads the relationship from either end', () => {
    // `entity_relationship` stores one row per pair. Being somebody's sister is
    // the same fact read the other way round, and a brief that only walked
    // `from → to` would miss half the graph depending on who typed it in.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(seed, [rel('Renn', 'Ilva')], ['Ilva', 'Renn']);
    expect(out.cast.map((c) => c.name)).toContain('Renn');
  });

  it('expands out of the setting as well as the cast', () => {
    // The location is not in `cast`, and an expansion that only walked `cast`
    // would silently never traverse it.
    const seed = seedBrief(input({
      scene: { ...input().scene, locationEntityId: 'the Kiln' },
      entities: world('the Kiln'),
    }));
    const out = expand(seed, [rel('the Kiln', 'the Guild')], ['the Kiln', 'the Guild']);
    expect(out.cast.map((c) => c.name)).toEqual(['the Guild']);
    expect(out.links[0]).toMatchObject({ fromEntityId: 'the Kiln', hop: 1 });
  });

  it('records the link but leaves a scene member at the role it already has', () => {
    const seed = seedBrief(input({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      mentions: [{ entityId: 'Renn', role: 'present' }],
      entities: world('Ilva', 'Renn'),
    }));
    const out = expand(seed, [rel('Ilva', 'Renn')], ['Ilva', 'Renn']);

    expect(out.cast).toHaveLength(2);
    expect(out.cast.find((c) => c.name === 'Renn')).toMatchObject({
      role: 'present', depth: 'standard', via: 'mention',
    });
    // One row per pair, walked from both ends, is still one link.
    expect(out.links).toHaveLength(1);
  });
});

describe('what the hop refuses to bring', () => {
  it('ignores a relationship that has not started yet', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(
      seed, [rel('Ilva', 'Renn', { sinceRank: 'z9z9z9' })], ['Ilva', 'Renn']);
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva']);
    expect(out.links).toEqual([]);
  });

  it('ignores a relationship that has already ended', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(
      seed, [rel('Ilva', 'Renn', { untilRank: 'a0' })], ['Ilva', 'Renn']);
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva']);
  });

  it('holds at the two ends of the window', () => {
    // Active means it had started by this scene and has not ended in it:
    // `since <= rank`, `until > rank`. A relationship that ends in this very
    // scene is over by the time the brief is compiled for it.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const at = seed.scene.globalRank;
    const starts = expand(
      seed, [rel('Ilva', 'Renn', { sinceRank: at })], ['Ilva', 'Renn']);
    const ends = expand(
      seed, [rel('Ilva', 'Renn', { untilRank: at })], ['Ilva', 'Renn']);

    expect(starts.cast.map((c) => c.name)).toContain('Renn');
    expect(ends.cast.map((c) => c.name)).not.toContain('Renn');
  });

  it('does not expand a secret relationship', () => {
    // The divergence from doc 03, and the reason for it: step 4 filters facts,
    // not relationships. A secret one traversed here would put its other end in
    // the brief with no spoiler check at all — "the Grey Warden" expanded to
    // Kaelen in chapter five.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(
      seed, [rel('Ilva', 'Kaelen', { isSecret: true })], ['Ilva', 'Kaelen']);
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva']);
    expect(out.links).toEqual([]);
  });

  it('stops at one hop when the beats say nothing', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(
      seed,
      [rel('Ilva', 'Renn'), rel('Renn', 'Ossa')],
      ['Ilva', 'Renn', 'Ossa'],
    );
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva', 'Renn']);
  });

  it('stops at one hop when the beats name somebody else', () => {
    // Having beats is not the exception — having beats that name the entity is.
    // Without this the guard above is only doing the work of "are there beats
    // at all", and every planned scene would quietly expand two deep.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
      beats: [beat('She waits for the tide', 'And it does not turn.')],
    }));
    const out = expand(
      seed,
      [rel('Ilva', 'Renn'), rel('Renn', 'Ossa')],
      ['Ilva', 'Renn', 'Ossa'],
    );
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva', 'Renn']);
  });
});

describe('the second hop a beat earns', () => {
  it('admits an entity two steps away that a beat names', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
      beats: [beat('Ossa refuses to sign')],
    }));
    const out = expand(
      seed,
      [rel('Ilva', 'Renn'), rel('Renn', 'Ossa')],
      ['Ilva', 'Renn', 'Ossa'],
    );
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva', 'Ossa', 'Renn']);
    expect(out.links.find((l) => l.toEntityId === 'Ossa'))
      .toMatchObject({ fromEntityId: 'Renn', hop: 2 });
  });

  it('accepts the name a beat actually uses', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
      beats: [beat('The turn', 'And the harbourmaster says no.')],
    }));
    const out = expand(
      seed,
      [rel('Ilva', 'Renn'), rel('Renn', 'Ossa')],
      ['Ilva', 'Renn', 'Ossa'],
      new Map([['Ossa', ['the harbourmaster']]]),
    );
    expect(out.cast.map((c) => c.name)).toContain('Ossa');
  });

  it('never takes a third', () => {
    // Named in a beat is not a licence to keep walking. Three hops from the
    // point of view is the whole world again, which is the thing doc 03's limit
    // exists to stop.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
      beats: [beat('Ossa and Pell both refuse')],
    }));
    const out = expand(
      seed,
      [rel('Ilva', 'Renn'), rel('Renn', 'Ossa'), rel('Ossa', 'Pell')],
      ['Ilva', 'Renn', 'Ossa', 'Pell'],
    );
    expect(out.cast.map((c) => c.name)).not.toContain('Pell');
  });
});

describe('what the hop does with what it cannot answer', () => {
  it('names an entity it could not resolve instead of dropping it', () => {
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const out = expand(seed, [rel('Ilva', 'ghost')], ['Ilva']);
    expect(out.unresolved).toEqual([{ kind: 'entity', id: 'ghost' }]);
    expect(out.cast.map((c) => c.name)).toEqual(['Ilva']);
  });

  it('leaves the seed it was given untouched', () => {
    // Step 1 is pure and this has to be too: compiling the same brief twice
    // must not give a different answer the second time.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Ilva', role: 'focus' }],
      entities: world('Ilva'),
    }));
    const before = JSON.stringify(seed);
    expand(seed, [rel('Ilva', 'ghost'), rel('Ilva', 'Renn')], ['Ilva', 'Renn']);
    expect(JSON.stringify(seed)).toBe(before);
  });

  it('puts what is in the scene ahead of what was reached from it', () => {
    // Same role, so the tie-break decides, and it is not the name: somebody
    // standing in the room outranks somebody a relationship dragged in, however
    // the alphabet feels about it.
    const seed = seedBrief(input({
      mentions: [{ entityId: 'Zzz', role: 'mentioned' }],
      entities: world('Zzz'),
    }));
    const out = expand(seed, [rel('Zzz', 'Aaa')], ['Zzz', 'Aaa']);
    expect(out.cast.map((c) => c.name)).toEqual(['Zzz', 'Aaa']);
  });
});
