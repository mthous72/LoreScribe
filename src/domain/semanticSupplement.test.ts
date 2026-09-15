import { describe, it, expect } from 'vitest';
import {
  semanticSupplement, supplementQuery, type Candidate, type SupplementInput,
} from './semanticSupplement';
import {
  attachFacts, expandOneHop, seedBrief, type Briefed, type EntityRow, type FactRow,
} from './sceneBrief';
import type { Ladder } from './continuityLadder';

/**
 * Step 7 is a filter on somebody else's search results, and doc 03 defines it
 * almost entirely by what it must leave out. So does this file. The retriever
 * has nothing to say about spoilers, and swapping it must not be able to
 * change what the brief is allowed to contain — every rule here holds whatever
 * produced the candidates.
 */

const AT = 'a1a1a1';

const entity = (id: string): EntityRow => ({
  id, name: id, typeKey: 'character', importance: 'minor', summary: null, description: null,
});

const fact = (id: string, over: Partial<FactRow> = {}): FactRow => ({
  id, subjectEntityId: 'Ilva', objectEntityId: null, predicate: 'is',
  statement: `${id}.`, certainty: 'canon', spoilerWeight: 0, isDramaticIrony: false,
  establishedRank: 'a0', revealedRank: 'a0', invalidatedRank: null, supersedesFactId: null,
  ...over,
});

/** Ilva's scene at the Kiln, with a purpose, a beat, one fact in and one out. */
const briefed = (over: { purpose?: string | null; facts?: FactRow[] } = {}): Briefed => {
  const world = new Map(['Ilva', 'the Kiln'].map((id) => [id, entity(id)]));
  const seed = seedBrief({
    scene: {
      id: 'here', title: 'Here', globalRank: AT,
      purpose: over.purpose === undefined ? 'Get her through the gate.' : over.purpose,
      summary: null, povEntityId: 'Ilva', povMode: null, tense: null,
      locationEntityId: 'the Kiln', wordCount: 0,
    },
    mentions: [],
    entities: world,
    beats: [{
      beatId: 'b1', title: 'She is asked directly', summary: 'And does not answer.',
      function: null, tension: null, role: 'payoff',
      arcId: 'arc', arcName: 'The seal', arcKind: 'mystery',
    }],
  });
  const expanded = expandOneHop({ seed, atRank: AT, relationships: [], entities: world });
  return attachFacts({
    expanded, atRank: AT,
    facts: over.facts ?? [
      fact('f-in'),
      fact('f-light', { revealedRank: null, spoilerWeight: 1 }),
    ],
  });
};

const hit = (
  ownerTable: Candidate['ownerTable'], ownerId: string, over: Partial<Candidate> = {},
): Candidate => ({
  ownerTable, ownerId, readerRank: 'a0', band: 'canon', score: 1,
  title: null, text: `${ownerTable} ${ownerId}`, ...over,
});

const ids = (out: { hits: { ownerId: string }[] }) => out.hits.map((h) => h.ownerId);

const run = (candidates: Candidate[], over: Partial<SupplementInput> = {}) =>
  semanticSupplement({ briefed: briefed(), atRank: AT, candidates, ...over });

describe('what the retriever is asked', () => {
  it('is the purpose and the beat text, nothing else', () => {
    // Not the prose, which finds scenes that sound like this one; not the
    // cast, which finds what the working set already covers.
    expect(supplementQuery(briefed())).toBe(
      'Get her through the gate.\nShe is asked directly\nAnd does not answer.');
  });

  it('skips what is not written', () => {
    expect(supplementQuery(briefed({ purpose: null })))
      .toBe('She is asked directly\nAnd does not answer.');
  });

  it('is carried on the result for the inspector', () => {
    expect(run([]).query).toBe(supplementQuery(briefed()));
  });
});

describe('already included', () => {
  it('leaves out the scene being written', () => {
    expect(ids(run([hit('scene', 'here'), hit('scene', 'past')]))).toEqual(['past']);
  });

  it('leaves out the working set, cast and setting alike', () => {
    expect(ids(run([
      hit('entity', 'Ilva', { readerRank: null }),
      hit('entity', 'the Kiln', { readerRank: null }),
      hit('entity', 'Renn', { readerRank: null }),
    ]))).toEqual(['Renn']);
  });

  it('leaves out a fact step 3 already admitted', () => {
    expect(ids(run([hit('fact', 'f-in'), hit('fact', 'f-other')]))).toEqual(['f-other']);
  });

  it('leaves out the scenes on the ladder', () => {
    const ladder: Ladder = {
      tail: { sceneId: 'tail', title: null, text: '', words: 0, truncated: false },
      scenes: [{ id: 'rung', title: null, summary: '' }],
      chapters: [], parts: [], missing: [],
    };
    expect(ids(run(
      [hit('scene', 'tail'), hit('scene', 'rung'), hit('scene', 'older')],
      { ladder },
    ))).toEqual(['older']);
  });
});

describe('rejected by the spoiler filter', () => {
  it('leaves out a withheld fact too light for the negative block', () => {
    // The reason `excluded` exists. It is not in `negative`, and a semantic hit
    // would otherwise carry it straight past the filter that rejected it.
    const b = briefed();
    expect(b.negative).toEqual([]);
    expect(b.excluded.map((f) => f.factId)).toEqual(['f-light']);
    expect(ids(run([hit('fact', 'f-light', { readerRank: 'a0' })]))).toEqual([]);
  });
});

describe('not yet behind the reader', () => {
  it('leaves out a scene that has not happened', () => {
    expect(ids(run([hit('scene', 'later', { readerRank: 'z9' })]))).toEqual([]);
  });

  it('gates a stranger’s fact on the rank it was revealed', () => {
    // Step 3 never saw a fact about somebody outside the working set, so this
    // is the only check it gets — and revealed is the right rank, because
    // established is exactly not enough.
    expect(ids(run([
      hit('fact', 'told', { readerRank: 'a0' }),
      hit('fact', 'told-here', { readerRank: AT }),
      hit('fact', 'untold-yet', { readerRank: 'z9' }),
      hit('fact', 'never-told', { readerRank: null }),
    ]))).toEqual(['told', 'told-here']);
  });

  it('does not gate a note or an entity, which have no place in the book', () => {
    expect(ids(run([
      hit('note', 'n1', { readerRank: null }),
      hit('entity', 'Renn', { readerRank: null }),
    ]))).toEqual(['Renn', 'n1']);
  });
});

describe('the reference band', () => {
  it('is never mixed in', () => {
    expect(ids(run([
      hit('note', 'imported', { readerRank: null, band: 'reference', score: 9 }),
      hit('note', 'ours', { readerRank: null }),
    ]))).toEqual(['ours']);
  });
});

describe('the top few', () => {
  it('keeps one hit per thing, at its best score', () => {
    const out = run([
      hit('scene', 's1', { score: 0.2, text: 'weak chunk' }),
      hit('scene', 's1', { score: 0.9, text: 'strong chunk' }),
      hit('scene', 's1', { score: 0.5, text: 'middle chunk' }),
    ]);
    expect(out.hits).toEqual([{
      ownerTable: 'scene', ownerId: 's1', title: null, text: 'strong chunk', score: 0.9,
    }]);
  });

  it('takes the best few and no more', () => {
    const many = Array.from({ length: 12 }, (_, i) => hit('note', `n${i}`, {
      readerRank: null, score: i,
    }));
    expect(ids(run(many))).toEqual(['n11', 'n10', 'n9', 'n8', 'n7']);
    expect(ids(run(many, { limit: 2 }))).toEqual(['n11', 'n10']);
  });

  it('breaks ties the same way every time', () => {
    const tied = [
      hit('note', 'b', { readerRank: null }),
      hit('scene', 'a'),
      hit('note', 'a', { readerRank: null }),
    ];
    expect(ids(run(tied))).toEqual(['a', 'b', 'a']);
    expect(run(tied).hits.map((h) => h.ownerTable)).toEqual(['note', 'note', 'scene']);
    expect(ids(run([...tied].reverse()))).toEqual(['a', 'b', 'a']);
  });
});
