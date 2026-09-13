import { describe, it, expect } from 'vitest';
import { buildCorpus, DEFAULT_SPEC } from './corpus';
import { isValidKey, isValidGlobalRank } from '../domain/sortKey';

/**
 * One encoding for one column.
 *
 * The corpus used to mint zero-padded integers for `sort_key` and `global_rank`
 * while `src/domain/sortKey.ts` produced fractional keys. Both are compared as
 * strings with `<=`, so the two orderings disagree, and whichever convention was
 * written second would have silently reordered the manuscript. Asserted here
 * rather than left as a thing that happens to be true today.
 */
function paramsFor(sqlFragment: string, index: number): unknown[] {
  const corpus = buildCorpus({ ...DEFAULT_SPEC, scenes: 24, chapters: 4, entities: 8, facts: 10 });
  return corpus.statements
    .flat()
    .filter((s) => s.sql.includes(sqlFragment))
    .map((s) => s.params[index]);
}

describe('the corpus uses the project’s own sort keys', () => {
  it('writes valid fractional sort keys for chapters', () => {
    const keys = paramsFor('INSERT INTO chapter', 4) as string[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(isValidKey(k), `chapter sort_key ${JSON.stringify(k)}`).toBe(true);
    expect([...keys].sort()).toEqual(keys);           // already in order
  });

  it('writes valid fractional sort keys for scenes', () => {
    const keys = paramsFor('INSERT INTO scene ', 3) as string[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(isValidKey(k), `scene sort_key ${JSON.stringify(k)}`).toBe(true);
  });

  it('writes global ranks that globalRank() would have produced', () => {
    const ranks = paramsFor('INSERT INTO scene ', 4) as string[];
    expect(ranks.length).toBeGreaterThan(0);
    for (const r of ranks) expect(isValidGlobalRank(r), `global_rank ${JSON.stringify(r)}`).toBe(true);
  });

  it('orders scenes by global_rank the same way it orders them by index', () => {
    // The property that actually matters: the materialised rank has to agree
    // with the intended reading order, across chapter boundaries.
    const ranks = paramsFor('INSERT INTO scene ', 4) as string[];
    expect([...ranks].sort()).toEqual(ranks);
  });

  it('is deterministic — the same seed gives the same keys', () => {
    const a = paramsFor('INSERT INTO scene ', 4);
    const b = paramsFor('INSERT INTO scene ', 4);
    expect(a).toEqual(b);
  });
});
