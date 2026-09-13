import { describe, it, expect } from 'vitest';
import { countSyllables, dialogueRatio, proseStats, aggregateStats } from './stats';

describe('syllable heuristic', () => {
  // Each case traced against the rule in docs/12 §7, including the ones the
  // heuristic gets wrong — recorded deliberately, so nobody "fixes" a number
  // here without realising the index it feeds was calibrated on this behaviour.
  it.each([
    ['cat', 1],        // <= 3 letters
    ['the', 1],
    ['hoped', 1],      // strip 'ed' -> 'hop'
    ['hopes', 1],      // strip 'es' -> 'hop'
    ['table', 2],      // trailing 'e' AFTER 'l' is sounded, not stripped
    ['candles', 2],    // same rule, 'es' after 'l'
    ['rhythm', 1],     // floor at 1, no vowel groups after 'y' handling
    ['yellow', 2],     // leading 'y' stripped -> 'ellow' -> e, o
    ['beautiful', 3],  // eau, i, u
    // Genuinely wrong: English says cor-ru-gat-ed, four. The heuristic strips
    // 'ed' to 'corrugat' and finds three vowel groups. Left as-is and asserted
    // at three, because the readability indices were calibrated on this
    // behaviour and "correcting" it here would shift every score in the app.
    ['corrugated', 3],
  ])('countSyllables(%j) === %i', (word, expected) => {
    expect(countSyllables(word)).toBe(expected);
  });

  it('never returns zero for a real word', () => {
    for (const w of ['strength', 'six', 'queue', 'business']) {
      expect(countSyllables(w)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('dialogue ratio', () => {
  it('measures characters inside paired quotes', () => {
    // "Go" is 2 characters inside quotes; the whole string is 12.
    const text = '"Go" he said';
    expect(dialogueRatio(text)).toBeCloseTo(2 / 12, 10);
  });

  it('treats curly quotes the same as straight ones', () => {
    expect(dialogueRatio('“Go” he said')).toBeCloseTo(dialogueRatio('"Go" he said'), 10);
  });

  it('degrades gracefully on an unclosed quote instead of swallowing the rest', () => {
    // Continuing speech across paragraphs legitimately opens without closing.
    // The unterminated run must not be counted as dialogue.
    const text = '"Go," he said. "I am not waiting';
    const r = dialogueRatio(text);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.5);
  });

  it('is zero for prose with no dialogue', () => {
    expect(dialogueRatio('The rain fell in sheets.')).toBe(0);
  });
});

describe('prose statistics', () => {
  it('computes Flesch scores from the published formulae', () => {
    const text = 'The cat sat on the mat. The dog ran.';
    const s = proseStats(text);
    // 9 words, 2 sentences. Syllables: the1 cat1 sat1 on1 the1 mat1 the1 dog1 ran1 = 9.
    expect(s.words).toBe(9);
    expect(s.sentences).toBe(2);
    expect(s.syllables).toBe(9);
    const wps = 9 / 2, spw = 9 / 9;
    expect(s.fleschReadingEase).toBeCloseTo(206.835 - 1.015 * wps - 84.6 * spw, 10);
    expect(s.fleschKincaidGrade).toBeCloseTo(0.39 * wps + 11.8 * spw - 15.59, 10);
  });

  it('returns null rather than NaN or a fake score for empty text', () => {
    const s = proseStats('');
    expect(s.fleschReadingEase).toBeNull();
    expect(s.fleschKincaidGrade).toBeNull();
    expect(s.words).toBe(0);
  });

  it('reports reading time at 220 wpm', () => {
    const text = Array.from({ length: 220 }, () => 'word').join(' ') + '.';
    expect(proseStats(text).readingMinutes).toBeCloseTo(1, 6);
  });

  it('counts -ly adverbs', () => {
    const s = proseStats('She walked slowly and spoke quietly to him.');
    expect(s.words).toBe(8);
    expect(s.adverbRatio).toBeCloseTo(2 / 8, 10);
  });
});

describe('aggregation', () => {
  it('recomputes indices from totals rather than averaging ratios', () => {
    // A mean of two scenes' scores is not the score of the two together when
    // they differ in length. Aggregating must equal measuring the whole.
    const a = 'The cat sat on the mat. The dog ran.';
    const b = 'Extraordinarily complicated sentences accumulate subordinate clauses, '
      + 'which multiply indefinitely, until comprehension deteriorates completely.';
    const whole = proseStats(`${a} ${b}`);
    const combined = aggregateStats([proseStats(a), proseStats(b)]);

    expect(combined.words).toBe(whole.words);
    expect(combined.sentences).toBe(whole.sentences);
    expect(combined.syllables).toBe(whole.syllables);
    expect(combined.fleschReadingEase!).toBeCloseTo(whole.fleschReadingEase!, 6);
  });

  it('is empty, not NaN, for no parts at all', () => {
    const s = aggregateStats([]);
    expect(s.words).toBe(0);
    expect(s.fleschReadingEase).toBeNull();
    expect(s.dialogueRatio).toBe(0);
  });
});
