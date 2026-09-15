import { describe, it, expect } from 'vitest';
import { gatherLaws, referenceBand, type LawRow, type LawsInput } from './lawsAndBans';
import {
  attachFacts, expandOneHop, seedBrief, type Briefed, type EntityRow, type FactRow,
} from './sceneBrief';
import type { Candidate } from './semanticSupplement';

/**
 * Step 8 is a scope filter, an ordering, a derivation and a hand-off. The scope
 * filter is where the tests concentrate, because doc 04 is blunt about the
 * failure mode: every rule in every prompt is the instruction at position 4000
 * that gets dropped. Each scope type gets a law that matches and one that does
 * not, and the two must come apart.
 */

const AT = 'a1a1a1';

const entity = (id: string): EntityRow => ({
  id, name: id, typeKey: 'character', importance: 'minor', summary: null, description: null,
});

const fact = (id: string, over: Partial<FactRow> = {}): FactRow => ({
  id, subjectEntityId: 'Ilva', objectEntityId: null, predicate: 'is',
  statement: `${id} is so.`, certainty: 'canon', spoilerWeight: 0, isDramaticIrony: false,
  establishedRank: 'a0', revealedRank: 'a0', invalidatedRank: null, supersedesFactId: null,
  ...over,
});

/** Ilva at the Kiln, one beat on the arc `arc-seal`. */
const briefed = (facts: FactRow[] = []): Briefed => {
  const world = new Map(['Ilva', 'the Kiln'].map((id) => [id, entity(id)]));
  const seed = seedBrief({
    scene: {
      id: 'here', title: null, globalRank: AT, purpose: null, summary: null,
      povEntityId: 'Ilva', povMode: null, tense: null, locationEntityId: 'the Kiln', wordCount: 0,
    },
    mentions: [],
    entities: world,
    beats: [{
      beatId: 'b1', title: 'Asked', summary: null, function: null, tension: null,
      role: 'develop', arcId: 'arc-seal', arcName: 'The seal', arcKind: 'mystery',
    }],
  });
  const expanded = expandOneHop({ seed, atRank: AT, relationships: [], entities: world });
  return attachFacts({ expanded, atRank: AT, facts });
};

const law = (id: string, over: Partial<LawRow> = {}): LawRow => ({
  id, scopeType: 'project', scopeId: null, category: 'style', severity: 'should',
  title: id, ruleText: `Rule ${id}.`, examplesGood: null, examplesBad: null,
  isSystem: false, active: true, sortKey: null, ...over,
});

const gather = (laws: LawRow[], over: Partial<LawsInput> = {}) => gatherLaws({
  briefed: briefed(), bookId: 'book', chapterId: 'chapter', laws, scenes: [], ...over,
});

const ids = (out: { laws: { id: string }[] }) => out.laws.map((l) => l.id);

describe('whose scope covers this scene', () => {
  it('always the project', () => {
    expect(ids(gather([law('p')]))).toEqual(['p']);
  });

  it('this book and not another', () => {
    expect(ids(gather([
      law('mine', { scopeType: 'book', scopeId: 'book' }),
      law('other', { scopeType: 'book', scopeId: 'sequel' }),
    ]))).toEqual(['mine']);
  });

  it('an arc one of its beats belongs to', () => {
    expect(ids(gather([
      law('mine', { scopeType: 'arc', scopeId: 'arc-seal' }),
      law('other', { scopeType: 'arc', scopeId: 'arc-love' }),
    ]))).toEqual(['mine']);
  });

  it('this chapter and this scene', () => {
    expect(ids(gather([
      law('ch', { scopeType: 'chapter', scopeId: 'chapter' }),
      law('ch-other', { scopeType: 'chapter', scopeId: 'elsewhere' }),
      law('sc', { scopeType: 'scene', scopeId: 'here' }),
      law('sc-other', { scopeType: 'scene', scopeId: 'there' }),
    ]))).toEqual(['ch', 'sc']);
  });

  it('somebody in the working set, the setting included', () => {
    expect(ids(gather([
      law('ilva', { scopeType: 'entity', scopeId: 'Ilva' }),
      law('kiln', { scopeType: 'entity', scopeId: 'the Kiln' }),
      law('renn', { scopeType: 'entity', scopeId: 'Renn' }),
    ]))).toEqual(['ilva', 'kiln']);
  });

  it('the point of view and nobody else’s', () => {
    expect(ids(gather([
      law('pov', { scopeType: 'pov', scopeId: 'Ilva' }),
      law('not', { scopeType: 'pov', scopeId: 'the Kiln' }),
    ]))).toEqual(['pov']);
  });

  it('nothing that has been switched off', () => {
    expect(ids(gather([law('off', { active: false }), law('on')]))).toEqual(['on']);
  });
});

describe('what step 5 already said', () => {
  it('leaves a character’s voice law in the dossier', () => {
    // Rendered next to that character's facts in step 5, whose header promised
    // this step would not list it again.
    expect(ids(gather([
      law('voice-entity', { category: 'voice', scopeType: 'entity', scopeId: 'Ilva' }),
      law('voice-pov', { category: 'voice', scopeType: 'pov', scopeId: 'Ilva' }),
      law('canon-entity', { category: 'canon', scopeType: 'entity', scopeId: 'Ilva' }),
    ]))).toEqual(['canon-entity']);
  });

  it('but gathers a voice law that is not about one character', () => {
    expect(ids(gather([law('house-voice', { category: 'voice' })]))).toEqual(['house-voice']);
  });
});

describe('the order they bind in', () => {
  it('must, then should, then prefer', () => {
    expect(ids(gather([
      law('a-prefer', { severity: 'prefer' }),
      law('b-should', { severity: 'should' }),
      law('c-must', { severity: 'must' }),
    ]))).toEqual(['c-must', 'b-should', 'a-prefer']);
  });

  it('the hard floor first among equals', () => {
    expect(ids(gather([
      law('a-ours', { severity: 'must' }),
      law('z-floor', { severity: 'must', isSystem: true }),
    ]))).toEqual(['z-floor', 'a-ours']);
  });

  it('then the writer’s own order', () => {
    expect(ids(gather([
      law('a', { sortKey: 'a2' }),
      law('z', { sortKey: 'a1' }),
    ]))).toEqual(['z', 'a']);
  });

  it('binds an unrecognised severity least', () => {
    const out = gather([law('odd', { severity: 'absolutely' }), law('soft', { severity: 'prefer' })]);
    expect(out.laws.find((l) => l.id === 'odd')?.severity).toBe('prefer');
  });
});

describe('canon', () => {
  it('restates an admitted canon fact as a thing not to contradict', () => {
    const out = gather([], { briefed: briefed([fact('dead')]) });
    expect(out.canon).toEqual([{
      factId: 'dead', subjectEntityId: 'Ilva', ruleText: 'dead is so.', severity: 'must',
    }]);
  });

  it('does not make a rule of something the writer has not settled', () => {
    // The first place certainty does any work. Step 3 carried these through so
    // step 5 could label them; this is the step that must not turn them into
    // constraints.
    const out = gather([], {
      briefed: briefed([
        fact('maybe', { certainty: 'speculative' }),
        fact('later', { certainty: 'planned' }),
        fact('sure'),
      ]),
    });
    expect(out.canon.map((c) => c.factId)).toEqual(['sure']);
  });

  it('never restates a fact the spoiler filter kept out', () => {
    const out = gather([], {
      briefed: briefed([fact('secret', { revealedRank: null, spoilerWeight: 3 })]),
    });
    expect(out.canon).toEqual([]);
  });
});

describe('the ban list', () => {
  const heavy = 'The corrugated iron sang in the wind. '.repeat(3);
  const scene = (id: string, rank: string, text: string | null) => ({
    id, globalRank: rank, chapterId: 'c', title: null, summary: null, text,
  });

  it('reads the prose already written, and only that', () => {
    const out = gather([], {
      scenes: [
        scene('past', 'a0', heavy),
        scene('future', 'z9', 'Nobody had ever seen the harbour so still. '.repeat(3)),
      ],
    });
    expect(out.bans.phrases.some((p) => p.includes('corrugated iron sang'))).toBe(true);
    expect(JSON.stringify(out.bans)).not.toContain('harbour');
  });

  it('reads what this scene already says, a beat at a time', () => {
    // D29: the next beat must not repeat the imagery of the one before it, and
    // that imagery is on the page already.
    const out = gather([], { currentText: heavy });
    expect(out.bans.phrases.some((p) => p.includes('corrugated iron sang'))).toBe(true);
  });

  it('lists recent openings, most recent last, and not this scene’s own', () => {
    const out = gather([], {
      scenes: [
        scene('s1', 'a0', 'First light. Then more.'),
        scene('s2', 'a0V', 'Second light. Then more.'),
      ],
      currentText: 'Third light. Then more.',
    });
    expect(out.bans.openings).toEqual(['First light.', 'Second light.']);
  });

  it('skips an unwritten scene when choosing openings', () => {
    const out = gather([], {
      scenes: [scene('s1', 'a0', 'Only light.'), scene('s2', 'a0V', null)],
    });
    expect(out.bans.openings).toEqual(['Only light.']);
  });
});

describe('8b — the reference band', () => {
  const hit = (ownerId: string, over: Partial<Candidate> = {}): Candidate => ({
    ownerTable: 'note', ownerId, readerRank: null, band: 'reference', score: 1,
    title: null, text: ownerId, ...over,
  });

  it('takes only the imported material', () => {
    expect(referenceBand([hit('ref'), hit('ours', { band: 'canon', score: 9 })])
      .map((h) => h.ownerId)).toEqual(['ref']);
  });

  it('does not gate on rank, because none of it is in the book', () => {
    expect(referenceBand([hit('r', { readerRank: 'z9' })]).map((h) => h.ownerId)).toEqual(['r']);
  });

  it('keeps the best chunk per source and the top few', () => {
    const out = referenceBand([
      hit('a', { score: 0.1, text: 'weak' }), hit('a', { score: 0.9, text: 'strong' }),
      hit('b', { score: 0.5 }), hit('c', { score: 0.4 }), hit('d', { score: 0.3 }),
    ]);
    expect(out.map((h) => `${h.ownerId}:${h.text}`)).toEqual(['a:strong', 'b:b', 'c:c']);
  });
});
