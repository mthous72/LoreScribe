import { describe, it, expect } from 'vitest';
import { locateQuote, normaliseEvidence } from './evidence';

/** Fixtures invented — D14. */

describe('normaliseEvidence', () => {
  it('lowercases, straightens quotes and dashes, and folds whitespace, keeping a map back', () => {
    const src = '  She said — “No.”\n\n\tHe   left. ';
    const n = normaliseEvidence(src);
    expect(n.text).toBe('she said - "no." he left.');
    expect(n.map).toHaveLength(n.text.length);
    // Each mapped index points at a character that folds to the one in the text.
    expect(src[n.map[n.text.indexOf('"no.')]!]).toBe('“');
    expect(src[n.map[n.text.indexOf('-')]!]).toBe('—');
    expect(src[n.map[n.text.indexOf(' he ') + 1]!]).toBe('H');
  });
});

describe('locateQuote', () => {
  const prose = 'The clerk waited. “You’ll want the ledger,” she said — and did not move.\n\nNobody came.';

  it('finds a quote retyped with straight quotes, a different dash, and folded spacing', () => {
    const hit = locateQuote(prose, '"you\'ll want   the ledger," she said - and');
    expect(hit).not.toBeNull();
    expect(hit!.quote).toBe('“You’ll want the ledger,” she said — and');
    expect(prose.slice(hit!.start, hit!.end)).toBe(hit!.quote);
  });

  it('spans a paragraph break', () => {
    const hit = locateQuote(prose, 'did not move. Nobody came.');
    expect(hit!.quote).toBe('did not move.\n\nNobody came.');
  });

  it('refuses a quote that is not there, and one too short to trust', () => {
    expect(locateQuote(prose, 'she smiled and said nothing')).toBeNull();
    expect(locateQuote(prose, 'the clerk')).toBeNull();          // 9 characters
    expect(locateQuote(prose, 'THE CLERK WAI')).not.toBeNull(); // 13, present
  });

  it('is exact at the boundaries of the source', () => {
    expect(locateQuote(prose, 'The clerk waited.')).toMatchObject({ start: 0 });
    const tail = locateQuote(prose, 'move.  Nobody came.');
    expect(tail!.end).toBe(prose.length);
  });
});
