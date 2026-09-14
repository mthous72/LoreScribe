import { describe, it, expect } from 'vitest';
import {
  attachFacts, expandOneHop, renderDossiers, seedBrief,
  type AliasRow, type BeatRow, type Dossier, type DossierInput, type EntityRow,
  type FactRow, type RelationshipRow, type SeedInput,
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

/* --------------------------------------- step 3: the facts, filtered in time */

/**
 * The two filters themselves belong to `factVisibility` and are tested there
 * exhaustively; repeating them here would be the second statement of a rule
 * that must only have one. What is tested here is the part doc 03 leaves to the
 * compiler: which facts get asked about, what happens to the answers, and the
 * three decisions the step had to make on its own — selection by subject,
 * subject-less facts as laws rather than facts, and only `knows` counting as
 * knowledge.
 */

const fact = (id: string, subject: string | null, over: Partial<FactRow> = {}): FactRow => ({
  id,
  subjectEntityId: subject,
  objectEntityId: null,
  predicate: 'is',
  statement: `${id}: a true thing about ${subject ?? 'nobody'}.`,
  certainty: 'canon',
  spoilerWeight: 0,
  isDramaticIrony: false,
  establishedRank: 'a0',
  revealedRank: 'a0',
  invalidatedRank: null,
  supersedesFactId: null,
  ...over,
});

/** A scene with `Ilva` as the point of view and `Renn` named in passing. */
const scene = () => expandOneHop({
  seed: seedBrief(input({
    scene: { ...input().scene, povEntityId: 'Ilva' },
    mentions: [{ entityId: 'Renn', role: 'mentioned' }],
    entities: world('Ilva', 'Renn'),
  })),
  atRank: 'a1a1a1',
  relationships: [],
  entities: world('Ilva', 'Renn'),
});

const withFacts = (facts: FactRow[], expanded = scene()) =>
  attachFacts({ expanded, atRank: expanded.scene.globalRank, facts });

describe('which facts the brief asks about', () => {
  it('takes a fact by its subject', () => {
    const out = withFacts([fact('f1', 'Ilva')]);
    expect(out.facts.map((f) => f.factId)).toEqual(['f1']);
  });

  it('does not take one merely pointed at', () => {
    // "Ilva is the Warden's sister" with only the Warden in the room would
    // arrive with no dossier to sit under, naming somebody who is not in the
    // brief. Step 2's links already say what the two are to each other.
    const out = withFacts([fact('f1', 'Ossa', { objectEntityId: 'Ilva' })]);
    expect(out.facts).toEqual([]);
  });

  it('leaves a fact with no subject to the laws', () => {
    const out = withFacts([fact('f1', null)]);
    expect(out.facts).toEqual([]);
  });

  it('takes facts about the place as readily as about the people', () => {
    const expanded = expandOneHop({
      seed: seedBrief(input({
        scene: { ...input().scene, locationEntityId: 'the Kiln' },
        entities: world('the Kiln'),
      })),
      atRank: 'a1a1a1', relationships: [], entities: world('the Kiln'),
    });
    const out = withFacts([fact('f1', 'the Kiln')], expanded);
    expect(out.facts.map((f) => f.factId)).toEqual(['f1']);
  });

  it('judges supersession against facts from outside the working set', () => {
    // Supersession is a relation. Selecting first and judging afterwards would
    // leave a replaced fact looking current whenever its replacement happens to
    // be about somebody who is not in the room.
    const out = withFacts([
      fact('old', 'Ilva'),
      fact('new', 'outsider', { supersedesFactId: 'old' }),
    ]);
    expect(out.facts).toEqual([]);
  });
});

describe('what the point of view is taken to know', () => {
  const secret = (over: Partial<FactRow> = {}) =>
    fact('f1', 'Renn', { revealedRank: null, spoilerWeight: 1, ...over });

  it('admits a fact the point of view knows, and says so', () => {
    const out = withFacts([secret({
      knowledge: [{ entityId: 'Ilva', belief: 'knows', knownFromRank: 'a0' }],
    })]);
    expect(out.facts[0]).toMatchObject({ status: 'pov-knows', povBelief: 'knows' });
  });

  it('does not admit one the point of view merely suspects', () => {
    // Suspecting is not knowing. Admitting it would let the model write as
    // settled a thing the character has not worked out yet.
    const out = withFacts([secret({
      knowledge: [{ entityId: 'Ilva', belief: 'suspects', knownFromRank: 'a0' }],
    })]);
    expect(out.facts).toEqual([]);
  });

  it('does not admit one the point of view believes false', () => {
    const out = withFacts([secret({
      knowledge: [{ entityId: 'Ilva', belief: 'believes_false', knownFromRank: 'a0' }],
    })]);
    expect(out.facts).toEqual([]);
  });

  it('keeps the belief on a fact the reader already has', () => {
    // She is wrong about something the reader was told in chapter one, and that
    // is the scene. Discarding the column would lose it.
    const out = withFacts([fact('f1', 'Renn', {
      knowledge: [{ entityId: 'Ilva', belief: 'believes_false', knownFromRank: 'a0' }],
    })]);
    expect(out.facts[0]).toMatchObject({ status: 'reader-knows', povBelief: 'believes_false' });
  });

  it('carries no belief for somebody else’s knowledge', () => {
    const out = withFacts([fact('f1', 'Renn', {
      knowledge: [{ entityId: 'Ossa', belief: 'knows', knownFromRank: 'a0' }],
    })]);
    expect(out.facts[0]?.povBelief).toBeNull();
  });
});

describe('what must not be said', () => {
  it('names a heavy secret about somebody in the scene', () => {
    const out = withFacts([
      fact('f1', 'Renn', { revealedRank: null, spoilerWeight: 3 }),
    ]);
    expect(out.facts).toEqual([]);
    expect(out.negative).toEqual([{
      factId: 'f1', subjectEntityId: 'Renn', spoilerWeight: 3,
      statement: 'f1: a true thing about Renn.', status: 'withheld',
    }]);
  });

  it('leaves a light one out of the budget', () => {
    const out = withFacts([
      fact('f1', 'Renn', { revealedRank: null, spoilerWeight: 1 }),
    ]);
    expect(out.negative).toEqual([]);
  });

  it('says nothing about people who are not here', () => {
    // Doc 03 is careful about the budget, and a secret about somebody absent is
    // not a thing this scene was going to mention.
    const out = withFacts([
      fact('f1', 'stranger', { revealedRank: null, spoilerWeight: 3 }),
    ]);
    expect(out.negative).toEqual([]);
  });

  it('puts the heaviest first', () => {
    // Named against the alphabet on purpose: the last tie-break is the id, and
    // ids that agree with the key under test would let it be dropped entirely.
    const out = withFacts([
      fact('a-light', 'Renn', { revealedRank: null, spoilerWeight: 2 }),
      fact('z-heavy', 'Renn', { revealedRank: null, spoilerWeight: 3 }),
    ]);
    expect(out.negative.map((n) => n.factId)).toEqual(['z-heavy', 'a-light']);
  });

  it('distinguishes a secret from an unwritten future', () => {
    // Both are excluded and both are dangerous, but they read differently: one
    // is true and untold, the other is not true yet — and foreshadowing the
    // second is the failure the negative block exists to stop.
    const out = withFacts([
      fact('later', 'Renn', {
        establishedRank: 'z9', revealedRank: 'z9', spoilerWeight: 3,
      }),
    ]);
    expect(out.negative[0]?.status).toBe('not-yet-established');
  });
});

describe('the order the facts arrive in', () => {
  // Every id below is named against the key under test, because the last
  // tie-break is the id: ids that happen to agree with the key would let it be
  // deleted outright with the suite still green.
  it('puts the scene’s own people first', () => {
    const out = withFacts([fact('a-renn', 'Renn'), fact('z-ilva', 'Ilva')]);
    expect(out.facts.map((f) => f.factId)).toEqual(['z-ilva', 'a-renn']);
  });

  it('then the weightiest', () => {
    const out = withFacts([
      fact('a-light', 'Ilva', { spoilerWeight: 0 }),
      fact('z-heavy', 'Ilva', { spoilerWeight: 3 }),
    ]);
    expect(out.facts.map((f) => f.factId)).toEqual(['z-heavy', 'a-light']);
  });

  it('then the most recently true, with backstory last', () => {
    const out = withFacts([
      fact('a-always', 'Ilva', { establishedRank: null }),
      fact('b-early', 'Ilva', { establishedRank: 'a0' }),
      fact('c-late', 'Ilva', { establishedRank: 'a1' }),
    ]);
    expect(out.facts.map((f) => f.factId)).toEqual(['c-late', 'b-early', 'a-always']);
  });
});

describe('what the step refuses to decide', () => {
  it('carries a speculative fact through rather than judging it', () => {
    // Dropping it silently and presenting it as canon are both wrong. Labelling
    // is step 5's job; this step keeps to one.
    const out = withFacts([fact('f1', 'Ilva', { certainty: 'speculative' })]);
    expect(out.facts[0]?.certainty).toBe('speculative');
  });

  it('leaves the expansion it was given intact', () => {
    const expanded = scene();
    const before = JSON.stringify(expanded);
    withFacts([fact('f1', 'Ilva'), fact('f2', 'nobody-at-all')], expanded);
    expect(JSON.stringify(expanded)).toBe(before);
  });
});

/* ----------------------------------------------- step 5: render the dossiers */

/**
 * The step where doc 03 contradicts itself: step 1 sizes by the role in this
 * scene, step 5 says `importance`. Most of what follows is about which of the
 * two won, because reading step 5 literally would undo step 1 at the last
 * moment — and the suite would still be green, since every earlier test stops
 * at `depth`.
 */

const briefed = (
  over: Partial<SeedInput> = {},
  relationships: RelationshipRow[] = [],
  facts: FactRow[] = [],
  entities?: Map<string, EntityRow>,
) => {
  const world_ = entities ?? over.entities as Map<string, EntityRow>;
  const expanded = expandOneHop({
    seed: seedBrief(input({ ...over, entities: world_ })),
    atRank: 'a1a1a1', relationships, entities: world_,
  });
  return attachFacts({ expanded, atRank: 'a1a1a1', facts });
};

const dossiers = (b: ReturnType<typeof briefed>, rest: Partial<DossierInput> = {}) =>
  renderDossiers({ briefed: b, atRank: 'a1a1a1', ...rest }).dossiers;

const find = (list: Dossier[], name: string) => list.find((d) => d.name === name);

describe('how large an entry gets', () => {
  it('sizes by the part played here, not by the part played in the book', () => {
    // The clerk holds the point of view and gets everything; the protagonist is
    // named in passing and gets a line. Doc 03 step 5 read literally reverses
    // both, and nothing earlier in this file would notice.
    const world_ = new Map([
      ['clerk', entity('clerk', { importance: 'background' })],
      ['hero', entity('hero', { importance: 'protagonist' })],
    ]);
    const out = dossiers(briefed({
      scene: { ...input().scene, povEntityId: 'clerk' },
      mentions: [{ entityId: 'hero', role: 'mentioned' }],
    }, [], [], world_));

    expect(find(out, 'clerk')).toMatchObject({
      depth: 'full', description: 'clerk, at length.', importance: 'background',
    });
    expect(find(out, 'hero')).toMatchObject({
      depth: 'name-only', description: null, importance: 'protagonist',
    });
  });

  it('gives a full entry its voice notes and a standard entry none', () => {
    const voiceNotes = [
      { entityId: 'Ilva', title: 'Clipped', ruleText: 'She does not explain.', severity: 'must' },
      { entityId: 'Renn', title: 'Warm', ruleText: 'He over-explains.', severity: 'should' },
    ];
    const out = dossiers(briefed({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      mentions: [{ entityId: 'Renn', role: 'present' }],
      entities: world('Ilva', 'Renn'),
    }), { voiceNotes });

    expect(find(out, 'Ilva')?.voice.map((v) => v.title)).toEqual(['Clipped']);
    expect(find(out, 'Renn')).toMatchObject({ depth: 'standard', voice: [] });
    expect(find(out, 'Renn')?.description).toBe('Renn, at length.');
  });

  it('gives a standard entry its facts', () => {
    const out = dossiers(briefed(
      {
        mentions: [{ entityId: 'Renn', role: 'present' }],
        entities: world('Renn'),
      },
      [],
      [fact('f1', 'Renn')],
    ));
    expect(find(out, 'Renn')?.facts.map((f) => f.factId)).toEqual(['f1']);
  });

  it('gives a name-only entry its line and nothing else', () => {
    const out = dossiers(briefed(
      {
        mentions: [{ entityId: 'Renn', role: 'mentioned' }],
        entities: world('Renn'),
      },
      [],
      [fact('f1', 'Renn')],
    ));
    expect(find(out, 'Renn')).toMatchObject({
      summary: 'Renn, in one line.',
      description: null,
      facts: [],
      aliases: [],
      voice: [],
    });
  });

  it('puts each fact under the entity it is about', () => {
    const out = dossiers(briefed(
      {
        scene: { ...input().scene, povEntityId: 'Ilva' },
        mentions: [{ entityId: 'Renn', role: 'present' }],
        entities: world('Ilva', 'Renn'),
      },
      [],
      [fact('f-ilva', 'Ilva'), fact('f-renn', 'Renn')],
    ));
    expect(find(out, 'Ilva')?.facts.map((f) => f.factId)).toEqual(['f-ilva']);
    expect(find(out, 'Renn')?.facts.map((f) => f.factId)).toEqual(['f-renn']);
  });
});

describe('the line that says why somebody came up', () => {
  it('keeps a name-only entry’s links', () => {
    // Step 2 admitted them *because* of the link. A bare name with no reason to
    // be in the brief costs the same tokens and says nothing.
    const out = dossiers(briefed(
      {
        scene: { ...input().scene, povEntityId: 'Ilva' },
        entities: world('Ilva', 'Renn'),
      },
      [rel('Ilva', 'Renn', { label: 'sister of' })],
    ));
    expect(find(out, 'Renn')).toMatchObject({ depth: 'name-only', description: null });
    expect(find(out, 'Renn')?.links).toEqual([{
      otherEntityId: 'Ilva', otherName: 'Ilva', kind: 'family',
      label: 'sister of', strength: 3,
    }]);
  });

  it('names the other end whichever way the row was typed in', () => {
    const out = dossiers(briefed(
      {
        scene: { ...input().scene, povEntityId: 'Ilva' },
        entities: world('Ilva', 'Renn'),
      },
      [rel('Renn', 'Ilva')],
    ));
    expect(find(out, 'Ilva')?.links[0]?.otherName).toBe('Renn');
    expect(find(out, 'Renn')?.links[0]?.otherName).toBe('Ilva');
  });

  it('drops a link whose other end never resolved', () => {
    const b = briefed(
      {
        scene: { ...input().scene, povEntityId: 'Ilva' },
        entities: world('Ilva'),
      },
      [rel('Ilva', 'ghost')],
    );
    expect(b.unresolved).toEqual([{ kind: 'entity', id: 'ghost' }]);
    expect(dossiers(b)[0]?.links).toEqual([]);
  });
});

describe('the names an entity answers to', () => {
  const aliasesOf = (rows: AliasRow[]) => {
    const out = dossiers(briefed({
      scene: { ...input().scene, povEntityId: 'Kaelen' },
      entities: world('Kaelen'),
    }), { aliases: rows });
    return out[0]?.aliases;
  };

  it('holds back one the reader cannot make yet', () => {
    // The schema names this case itself: an alias may be a spoiler, and "the
    // Grey Warden is Kaelen" inside the section meant to help the model pick
    // the right name is the worst place to give it away.
    expect(aliasesOf([
      { entityId: 'Kaelen', alias: 'the Grey Warden', kind: 'epithet', linkableFromRank: 'z9' },
      { entityId: 'Kaelen', alias: 'Kae', kind: 'nickname', linkableFromRank: null },
    ])).toEqual(['Kae']);
  });

  it('allows one the book has already made', () => {
    expect(aliasesOf([
      { entityId: 'Kaelen', alias: 'the Grey Warden', kind: 'epithet', linkableFromRank: 'a0' },
    ])).toEqual(['the Grey Warden']);
  });

  it('allows one this very scene makes', () => {
    // The same convention a revealed fact takes: at or before the rank means
    // available. The scene where the alias becomes usable is the scene that
    // reveals it, and refusing it there would make the reveal unwritable.
    expect(aliasesOf([
      { entityId: 'Kaelen', alias: 'the Grey Warden', kind: 'epithet', linkableFromRank: 'a1a1a1' },
    ])).toEqual(['the Grey Warden']);
  });

  it('does not repeat the name it already has', () => {
    expect(aliasesOf([
      { entityId: 'Kaelen', alias: 'KAELEN', kind: 'name', linkableFromRank: null },
      { entityId: 'Kaelen', alias: 'Kae', kind: 'nickname', linkableFromRank: null },
      { entityId: 'Kaelen', alias: 'Kae', kind: 'nickname', linkableFromRank: null },
    ])).toEqual(['Kae']);
  });
});

describe('the shape of the rendered brief', () => {
  it('runs the cast first and the setting after it', () => {
    const out = dossiers(briefed({
      scene: { ...input().scene, povEntityId: 'Ilva', locationEntityId: 'the Kiln' },
      mentions: [{ entityId: 'Renn', role: 'present' }],
      entities: world('Ilva', 'Renn', 'the Kiln'),
    }));
    expect(out.map((d) => d.name)).toEqual(['Ilva', 'Renn', 'the Kiln']);
    expect(find(out, 'the Kiln')?.via).toBe('location');
  });

  it('leaves the brief it was given intact', () => {
    const b = briefed({
      scene: { ...input().scene, povEntityId: 'Ilva' },
      entities: world('Ilva', 'Renn'),
    }, [rel('Ilva', 'Renn')], [fact('f1', 'Ilva')]);
    const before = JSON.stringify(b);
    renderDossiers({ briefed: b, atRank: 'a1a1a1' });
    expect(JSON.stringify(b)).toBe(before);
  });
});
