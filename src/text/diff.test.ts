import { describe, it, expect } from 'vitest';
import {
  opcodes, tokenise, diffWords, paragraphs, diffParagraphs, diffStats, collapse,
  type ParagraphChange, type Run,
} from './diff';

/**
 * The diff.
 *
 * What is worth asserting is not "it finds a difference" — almost anything
 * does. It is the three properties a writer would notice the absence of: that
 * the runs reassemble into the exact drafts they came from, that a small edit
 * reads as a small edit, and that a paragraph the writer did not touch is not
 * reported as touched because one near it was.
 */

const shape = (runs: readonly Run[]) => runs.map((r) => `${r.kind[0]}:${r.text}`);
const kinds = (changes: readonly ParagraphChange[]) => changes.map((c) => c.kind);

describe('opcodes', () => {
  it('covers both sequences completely, with no gaps', () => {
    const a = [...'the quick brown fox'];
    const b = [...'the lazy brown dog'];
    let i = 0;
    let j = 0;
    for (const op of opcodes(a, b)) {
      expect([op.aStart, op.bStart]).toEqual([i, j]);
      i = op.aEnd;
      j = op.bEnd;
    }
    expect([i, j]).toEqual([a.length, b.length]);
  });

  it('says nothing changed when nothing changed', () => {
    expect(opcodes([...'same'], [...'same'])).toEqual(
      [{ kind: 'equal', aStart: 0, aEnd: 4, bStart: 0, bEnd: 4 }]);
  });

  it('never reports two touching equal runs', () => {
    // An invariant, not a demonstration: the merge in `opcodes` cannot fire
    // while the matcher's blocks are maximal, and this is the assertion that
    // would catch it if difflib's autojunk were ever turned on — which is the
    // one thing that makes blocks touch.
    for (const [a, b] of [
      ['abcdef', 'abcdef'], ['the quick fox', 'the slow fox'], ['abcabc', 'cabcab'],
    ]) {
      const kinds = opcodes([...a!], [...b!]).map((o) => o.kind);
      expect(kinds.some((k, i) => k === 'equal' && kinds[i + 1] === 'equal'), `${a} / ${b}`)
        .toBe(false);
    }
  });

  it('calls an empty side an insert or a delete, never a replace', () => {
    expect(opcodes([], [1, 2]).map((o) => o.kind)).toEqual(['insert']);
    expect(opcodes([1, 2], []).map((o) => o.kind)).toEqual(['delete']);
    expect(opcodes([], [])).toEqual([]);
  });
});

describe('word runs', () => {
  it('keeps the whitespace, so the runs are the writer’s own text', () => {
    // Lossless by construction: the gaps are tokens too. A renderer that had to
    // put the spaces back would put them back wrongly around punctuation.
    expect(tokenise('a  b\nc').join('')).toBe('a  b\nc');
  });

  it('reassembles into exactly the two drafts it was given', () => {
    const a = 'She walked to the door and stopped.';
    const b = 'She walked to the door, and then stopped.';
    const runs = diffWords(a, b);
    const side = (skip: string) => runs.filter((r) => r.kind !== skip).map((r) => r.text).join('');
    expect(side('insert')).toBe(a);
    expect(side('delete')).toBe(b);
  });

  it('changes one word without disturbing the sentence around it', () => {
    expect(shape(diffWords('the red cat', 'the blue cat')))
      .toEqual(['e:the ', 'd:red', 'i:blue', 'e: cat']);
  });

  it('puts the deletion before the insertion that replaced it', () => {
    // Not cosmetic: a renderer showing them the other way round reads as the
    // new text having been removed.
    const runs = diffWords('one', 'two');
    expect(runs.map((r) => r.kind)).toEqual(['delete', 'insert']);
  });

  it('treats punctuation as part of the word it is attached to', () => {
    // "stopped." becoming "stopped," is one word changed, not a comma appearing
    // out of nowhere next to an untouched word.
    expect(shape(diffWords('he stopped.', 'he stopped,')))
      .toEqual(['e:he ', 'd:stopped.', 'i:stopped,']);
  });

  it('handles either side being empty', () => {
    expect(shape(diffWords('', 'new text'))).toEqual(['i:new text']);
    expect(shape(diffWords('old text', ''))).toEqual(['d:old text']);
    expect(diffWords('', '')).toEqual([]);
  });

  it('falls back to a wholesale replacement rather than hanging on a huge paragraph', () => {
    // The matcher is quadratic in the worst case. A writer who put a whole
    // scene in one block gets a coarser answer instantly instead of a perfect
    // one after the tab stops responding.
    const huge = (word: string) => Array.from({ length: 4_500 }, () => word).join(' ');
    expect(diffWords(huge('a'), huge('b')).map((r) => r.kind)).toEqual(['delete', 'insert']);
  });
});

describe('paragraphs', () => {
  it('drops blank lines rather than comparing them', () => {
    // Every blank line is identical to every other, so keeping them lets the
    // matcher align the blank in paragraph one with the blank in paragraph ten.
    expect(paragraphs('one\n\n  \ntwo\n')).toEqual(['one', 'two']);
  });

  it('leaves an untouched paragraph untouched when its neighbour changes', () => {
    const a = 'First paragraph, unchanged.\nSecond paragraph, the old version.';
    const b = 'First paragraph, unchanged.\nSecond paragraph, the new version.';
    expect(kinds(diffParagraphs(a, b))).toEqual(['equal', 'changed']);
  });

  it('shows a revised paragraph as a revision, word by word', () => {
    const a = 'She crossed the yard in the rain.';
    const b = 'She crossed the yard in the snow.';
    const [change] = diffParagraphs(a, b);
    expect(change?.kind).toBe('changed');
    if (change?.kind !== 'changed') throw new Error('expected a revision');
    expect(shape(change.runs)).toEqual(['e:She crossed the yard in the ', 'd:rain.', 'i:snow.']);
  });

  it('shows a paragraph that shares nothing with its neighbour as both, not as a smear', () => {
    // Pairing these would render every word struck through and every word new,
    // which is longer and harder to read than simply showing the two.
    const changes = diffParagraphs('The harbour was empty.', 'Renn counted his coins again.');
    expect(kinds(changes)).toEqual(['delete', 'insert']);
  });

  it('does not shift every later pair by one when a paragraph is inserted', () => {
    // The lookahead earns its keep here. Without it the inserted paragraph
    // pairs with the revised one, and everything after it reports as rewritten.
    const a = 'Alpha one, the old line.\nBeta two, the old line.';
    const b = 'Alpha one, the new line.\nA brand new paragraph entirely.\nBeta two, the new line.';
    expect(kinds(diffParagraphs(a, b))).toEqual(['changed', 'insert', 'changed']);
  });

  it('finds nothing to report between a draft and itself', () => {
    const text = 'One.\nTwo.\nThree.';
    expect(kinds(diffParagraphs(text, text))).toEqual(['equal', 'equal', 'equal']);
    expect(diffStats(diffParagraphs(text, text))).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it('counts what arrived and what went, in words', () => {
    const stats = diffStats(diffParagraphs('the red cat sat', 'the blue cat sat down'));
    expect(stats).toEqual({ added: 2, removed: 1, unchanged: 0 });
  });
});

describe('collapsing', () => {
  const draft = (n: number, changeAt: number) =>
    Array.from(
      { length: n },
      (_, i) => `Paragraph ${i}, which the writer ${i === changeAt ? 'revised' : 'left alone'}.`,
    ).join('\n');

  it('hides untouched prose but keeps the change in context', () => {
    const changes = diffParagraphs(draft(40, -1), draft(40, 20));
    const lines = collapse(changes, 1);
    expect(lines.filter((l) => l.kind === 'gap')).toHaveLength(2);
    // Three lines survive: the change and one either side.
    expect(lines.filter((l) => l.kind !== 'gap')).toHaveLength(3);
  });

  it('accounts for every paragraph, whether shown or counted in a gap', () => {
    const changes = diffParagraphs(draft(40, -1), draft(40, 20));
    const lines = collapse(changes, 1);
    const shown = lines.filter((l) => l.kind !== 'gap').length;
    const hidden = lines.reduce((n, l) => n + (l.kind === 'gap' ? l.paragraphs : 0), 0);
    expect(shown + hidden).toBe(changes.length);
  });

  it('leaves a short diff alone', () => {
    const changes = diffParagraphs('one\ntwo', 'one\nthree');
    expect(collapse(changes, 1)).toEqual(changes);
  });
});
