import { describe, it, expect } from 'vitest';
import {
  factVisibilityAt, negativeConstraints, continuityProblems, type FactForVisibility,
} from './factVisibility';

/**
 * The spoiler rule.
 *
 * Every case doc 03 §§3–4 describes, plus the boundaries it does not spell out
 * — because "at or before" versus "before" is one character in the source and
 * the difference between a reader being told something in the scene that
 * reveals it and being told it one scene early.
 */

const fact = (over: Partial<FactForVisibility> & { id: string }): FactForVisibility => ({
  establishedRank: null,
  revealedRank: null,
  invalidatedRank: null,
  supersedesFactId: null,
  isDramaticIrony: false,
  spoilerWeight: 0,
  ...over,
});

// Ranks sort lexicographically, which is what global_rank is for.
const [CH1, CH2, CH3] = ['a1', 'a2', 'a3'];

const statusOf = (facts: FactForVisibility[], at: string, pov?: string) =>
  Object.fromEntries(
    [...factVisibilityAt(facts, at, { povEntityId: pov })].map(([id, v]) => [id, v.status]));

describe('the temporal filter', () => {
  it('hides a fact that is not true yet, and shows it once it is', () => {
    const f = [fact({ id: 'f', establishedRank: CH2, revealedRank: CH2 })];
    expect(statusOf(f, CH1)).toEqual({ f: 'not-yet-established' });
    expect(statusOf(f, CH2)).toEqual({ f: 'reader-knows' });
  });

  it('treats a null established rank as true from the beginning', () => {
    // Backstory. The column's own convention, honoured here.
    expect(statusOf([fact({ id: 'f', revealedRank: CH1 })], CH1)).toEqual({ f: 'reader-knows' });
  });

  it('drops a fact from the scene that invalidates it onward', () => {
    const f = [fact({ id: 'f', revealedRank: CH1, invalidatedRank: CH2 })];
    expect(statusOf(f, CH1)).toEqual({ f: 'reader-knows' });
    // Invalidated AT this scene means no longer true here — `> scene`, per
    // doc 03. The off-by-one is the difference between a character being alive
    // in the scene that kills them and not.
    expect(statusOf(f, CH2)).toEqual({ f: 'invalidated' });
  });
});

describe('supersession', () => {
  it('replaces the old fact only once the replacement is itself true', () => {
    const facts = [
      fact({ id: 'old', revealedRank: CH1 }),
      fact({ id: 'new', establishedRank: CH3, revealedRank: CH3, supersedesFactId: 'old' }),
    ];
    // In chapter one the revision has not happened, so the original stands. A
    // revision written for chapter three must not delete the original from
    // every scene before it.
    expect(statusOf(facts, CH1)).toEqual({ old: 'reader-knows', new: 'not-yet-established' });
    expect(statusOf(facts, CH3)).toEqual({ old: 'superseded', new: 'reader-knows' });
  });

  it('does not let an invalidated replacement kill the thing it replaced', () => {
    const facts = [
      fact({ id: 'old', revealedRank: CH1 }),
      fact({
        id: 'new', establishedRank: CH2, invalidatedRank: CH3,
        revealedRank: CH2, supersedesFactId: 'old',
      }),
    ];
    expect(statusOf(facts, CH3).old).toBe('reader-knows');
  });
});

describe('the spoiler filter', () => {
  it('withholds a fact that is true but not yet told', () => {
    const f = [fact({ id: 'f', revealedRank: CH3 })];
    expect(statusOf(f, CH1)).toEqual({ f: 'withheld' });
    expect(statusOf(f, CH3)).toEqual({ f: 'reader-knows' });
  });

  it('lets dramatic irony through, because the reader already knows', () => {
    const f = [fact({ id: 'f', isDramaticIrony: true })];
    expect(statusOf(f, CH1)).toEqual({ f: 'dramatic-irony' });
  });

  it('lets the POV character’s own knowledge through, labelled as theirs', () => {
    const f = [fact({ id: 'f', revealedRank: CH3, knownFrom: { ilva: CH1 } })];
    // The distinction the label carries: Ilva may act on this; the narration
    // may not state it.
    expect(statusOf(f, CH2, 'ilva')).toEqual({ f: 'pov-knows' });
    expect(statusOf(f, CH2, 'renn')).toEqual({ f: 'withheld' });
    expect(statusOf(f, CH2)).toEqual({ f: 'withheld' });
  });

  it('does not let the POV know it before they learned it', () => {
    const f = [fact({ id: 'f', revealedRank: CH3, knownFrom: { ilva: CH2 } })];
    expect(statusOf(f, CH1, 'ilva')).toEqual({ f: 'withheld' });
    expect(statusOf(f, CH2, 'ilva')).toEqual({ f: 'pov-knows' });
  });

  it('treats a known-with-no-scene as known from the start', () => {
    // The same reading a null established rank gets: backstory knowledge.
    const f = [fact({ id: 'f', revealedRank: CH3, knownFrom: { ilva: null } })];
    expect(statusOf(f, CH1, 'ilva')).toEqual({ f: 'pov-knows' });
  });

  it('never reveals a fact merely because someone else knows it', () => {
    const f = [fact({ id: 'f', revealedRank: CH3, knownFrom: { renn: CH1 } })];
    expect(statusOf(f, CH1, 'ilva')).toEqual({ f: 'withheld' });
  });
});

describe('negative constraints', () => {
  const at = (facts: FactForVisibility[], rank: string) =>
    negativeConstraints(facts, factVisibilityAt(facts, rank)).map((f) => f.id);

  it('names a heavy secret that is being withheld', () => {
    const facts = [
      fact({ id: 'heavy', revealedRank: CH3, spoilerWeight: 3 }),
      fact({ id: 'light', revealedRank: CH3, spoilerWeight: 1 }),
    ];
    // Silence is not enough; a model confabulates into the gap. The heavy one
    // is named as forbidden, the trivial one is not worth the budget.
    expect(at(facts, CH1)).toEqual(['heavy']);
  });

  it('also names a heavy fact that is not true yet — broader than doc 03 §4', () => {
    // The document derives constraints from the spoiler filter alone, so this
    // case falls through it. A revelation that becomes true in chapter three is
    // exactly what must not be foreshadowed in chapter one.
    expect(at([fact({ id: 'late', establishedRank: CH3, spoilerWeight: 3 })], CH1))
      .toEqual(['late']);
  });

  it('says nothing about a fact that is merely wrong now', () => {
    // Invalidated and superseded facts are not secrets. Naming them would spend
    // budget telling a model about something it had no reason to mention.
    const facts = [
      fact({ id: 'dead', revealedRank: CH1, invalidatedRank: CH2, spoilerWeight: 3 }),
      fact({ id: 'old', revealedRank: CH1, spoilerWeight: 3 }),
      fact({ id: 'new', revealedRank: CH1, supersedesFactId: 'old', spoilerWeight: 3 }),
    ];
    expect(at(facts, CH2)).toEqual([]);
  });

  it('says nothing about a fact the reader already has', () => {
    expect(at([fact({ id: 'known', revealedRank: CH1, spoilerWeight: 3 })], CH2)).toEqual([]);
  });
});

describe('continuity problems', () => {
  const kinds = (f: FactForVisibility[]) => continuityProblems(f).map((p) => p.kind);

  it('catches a reveal that lands before the thing is true', () => {
    expect(kinds([fact({ id: 'f', establishedRank: CH2, revealedRank: CH1 })]))
      .toEqual(['revealed-before-established']);
  });

  it('catches something that stops being true before it starts', () => {
    expect(kinds([fact({ id: 'f', establishedRank: CH2, invalidatedRank: CH1 })]))
      .toContain('invalidated-before-established');
  });

  it('flags a significant secret that is never paid off', () => {
    expect(kinds([fact({ id: 'f', spoilerWeight: 3 })])).toEqual(['never-revealed']);
    // An ordinary unrevealed fact is not a problem — most of a world is never
    // stated on the page.
    expect(kinds([fact({ id: 'f', spoilerWeight: 0 })])).toEqual([]);
  });

  it('is quiet about a record that holds together', () => {
    expect(kinds([
      fact({ id: 'a', establishedRank: CH1, revealedRank: CH2, spoilerWeight: 3 }),
      fact({ id: 'b', revealedRank: CH1 }),
    ])).toEqual([]);
  });
});
