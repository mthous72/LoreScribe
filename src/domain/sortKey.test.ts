import { describe, it, expect } from 'vitest';
import {
  keyBetween, keysBetween, firstKey, initialKeys, needsRebalance, rebalance,
  globalRank, SortKeyError, REBALANCE_LENGTH,
} from './sortKey';

const sorted = (xs: readonly string[]) => [...xs].sort();
const isOrdered = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

describe('key generation', () => {
  it('starts at a0 and walks forward', () => {
    expect(firstKey()).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween('a1', null)).toBe('a2');
  });

  it('walks backward before the first key', () => {
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween(null, 'Zz')).toBe('Zy');
  });

  it('mints a midpoint between neighbours without touching them', () => {
    const mid = keyBetween('a0', 'a1');
    expect(mid > 'a0').toBe(true);
    expect(mid < 'a1').toBe(true);
  });

  it('keeps working when the same gap is used over and over', () => {
    // The case that decides whether this scheme survives real editing: a writer
    // repeatedly dropping a scene into the same slot.
    let lo = 'a0';
    const hi = 'a1';
    const made: string[] = [];
    for (let i = 0; i < 60; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo && k < hi, `${k} not strictly between ${lo} and ${hi}`).toBe(true);
      made.push(k);
      lo = k;
    }
    expect(isOrdered(made)).toBe(true);
  });

  it('rejects a reversed or equal pair rather than producing nonsense', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow(SortKeyError);
    expect(() => keyBetween('a1', 'a1')).toThrow(SortKeyError);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', '0', 'a', 'a0!', '!0']) {
      expect(() => keyBetween(bad, null), bad).toThrow(SortKeyError);
    }
  });

  it('crosses the magnitude boundary correctly', () => {
    // 'az' is the last single-digit positive magnitude; the next key has to
    // widen rather than wrap, or ordering silently breaks at item 63.
    let k = 'a0';
    const all = [k];
    for (let i = 0; i < 200; i++) { k = keyBetween(k, null); all.push(k); }
    expect(isOrdered(all)).toBe(true);
    expect(all.some((x) => x.startsWith('b'))).toBe(true);
  });
});

describe('bulk generation', () => {
  it('returns ordered keys in every direction', () => {
    for (const [a, b] of [[null, null], ['a0', null], [null, 'a0'], ['a0', 'a1']] as const) {
      const keys = keysBetween(a, b, 10);
      expect(keys).toHaveLength(10);
      expect(isOrdered(keys), `${a}..${b}: ${keys.join(',')}`).toBe(true);
      if (a !== null) expect(keys[0]! > a).toBe(true);
      if (b !== null) expect(keys[keys.length - 1]! < b).toBe(true);
    }
  });

  it('splits rather than chains, so keys stay short', () => {
    // Chaining keyBetween 64 times inside one gap grows a digit per insert.
    // Splitting keeps them compact, which is the point of doing it at all.
    const keys = keysBetween('a0', 'a1', 64);
    expect(isOrdered(keys)).toBe(true);
    const longest = Math.max(...keys.map((k) => k.length));
    expect(longest, `longest key was ${longest}`).toBeLessThanOrEqual(REBALANCE_LENGTH);
  });

  it('handles the degenerate counts', () => {
    expect(keysBetween('a0', 'a1', 0)).toEqual([]);
    expect(keysBetween('a0', 'a1', 1)).toHaveLength(1);
  });
});

describe('a simulated editing session', () => {
  it('survives a thousand random inserts and stays ordered', () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const keys = initialKeys(5);
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(rnd() * (keys.length + 1));
      const before = at === 0 ? null : keys[at - 1]!;
      const after = at === keys.length ? null : keys[at]!;
      keys.splice(at, 0, keyBetween(before, after));
    }
    expect(isOrdered(keys), 'keys went out of order').toBe(true);
    expect(sorted(keys)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('rebalancing', () => {
  it('only flags a list once a key is genuinely long', () => {
    expect(needsRebalance(initialKeys(50))).toBe(false);
    expect(needsRebalance(['a0', 'a0'.padEnd(REBALANCE_LENGTH + 1, 'V')])).toBe(true);
  });

  it('preserves order and reports only the rows that change', () => {
    let lo = 'a0';
    const items = [{ id: 'first', key: 'a0' }];
    for (let i = 0; i < 30; i++) {
      lo = keyBetween(lo, 'a1');
      items.push({ id: `n${i}`, key: lo });
    }
    items.push({ id: 'last', key: 'a1' });

    const order = [...items].sort((a, b) => (a.key < b.key ? -1 : 1)).map((i) => i.id);
    const changes = rebalance(items, (i) => i.key);

    const applied = new Map(changes.map((c) => [c.item.id, c.key]));
    const after = items
      .map((i) => ({ id: i.id, key: applied.get(i.id) ?? i.key }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((i) => i.id);
    expect(after).toEqual(order);
    expect(changes.length).toBeLessThanOrEqual(items.length);
  });

  it('changes nothing when a list is already even', () => {
    const items = initialKeys(10).map((key, i) => ({ id: String(i), key }));
    expect(rebalance(items, (i) => i.key)).toEqual([]);
  });
});

describe('global rank', () => {
  it('orders by part, then chapter, then scene', () => {
    const rows = [
      { p: 'a1', c: 'a0', s: 'a0' },
      { p: 'a0', c: 'a1', s: 'a0' },
      { p: 'a0', c: 'a0', s: 'a1' },
      { p: 'a0', c: 'a0', s: 'a0' },
    ].map((r) => ({ ...r, rank: globalRank([r.p, r.c, r.s]) }));

    const order = [...rows].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((r) => `${r.p}/${r.c}/${r.s}`);
    expect(order).toEqual(['a0/a0/a0', 'a0/a0/a1', 'a0/a1/a0', 'a1/a0/a0']);
  });

  it('keeps a short key before a longer one that extends it', () => {
    // Naive concatenation gets this wrong the moment a separator sorts below a
    // digit, and the symptom is a scene silently jumping chapters.
    expect(globalRank(['a0', 'a0', 'a0']) < globalRank(['a0', 'a0', 'a0V'])).toBe(true);
    expect(globalRank(['a0', 'a0V', 'a0']) > globalRank(['a0', 'a0', 'zz'])).toBe(true);
  });

  it('treats a missing level as sorting first', () => {
    expect(globalRank([null, 'a0', 'a0']) < globalRank(['a0', 'a0', 'a0'])).toBe(true);
  });
});
