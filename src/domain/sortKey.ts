/**
 * Fractional sort keys — docs/12 §9.
 *
 * Scenes, chapters, parts, arcs and beats order by a lexicographically
 * sortable string. Inserting between two siblings mints a midpoint key and
 * touches nothing else, so dragging one scene writes one row rather than
 * renumbering a chapter. That matters more here than in most apps: the whole
 * temporal model addresses narrative position by scene reference, and a
 * reorder that rewrote every key would churn the graph underneath it.
 *
 * Keys look like `a0`, `a1`, `a0V`. The first character encodes how many
 * digits the integer part has, which is what lets the sequence extend forever
 * in both directions without a fixed range: `a`–`z` are positive magnitudes of
 * 1 to 26 digits, `A`–`Z` negative.
 *
 * Written fresh; the scheme itself is a published algorithm, not borrowed
 * expression, and nothing here comes from either reference project.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST = DIGITS[0]!;
const LARGEST = DIGITS[DIGITS.length - 1]!;

/** Past this, a key is doing more work than it should — see `needsRebalance`. */
export const REBALANCE_LENGTH = 12;

export class SortKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'SortKeyError'; }
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new SortKeyError(`invalid order-key head: ${JSON.stringify(head)}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]!);
  if (len > key.length) throw new SortKeyError(`order key too short: ${key}`);
  return key.slice(0, len);
}

function validate(key: string): void {
  if (key === '') throw new SortKeyError('order key must not be empty');
  const int = integerPart(key);
  const frac = key.slice(int.length);
  for (const ch of key.slice(1)) {
    if (!DIGITS.includes(ch)) throw new SortKeyError(`invalid digit in ${key}`);
  }
  // A trailing smallest-digit is redundant and breaks midpoint's invariants.
  if (frac.endsWith(SMALLEST)) throw new SortKeyError(`order key has a trailing zero: ${key}`);
}

function incrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i]!) + 1;
    if (next === DIGITS.length) digits[i] = SMALLEST;
    else { digits[i] = DIGITS[next]!; carry = false; }
  }
  if (!carry) return head + digits.join('');
  // Overflowed this magnitude: widen it.
  if (head === 'Z') return 'a' + SMALLEST;
  if (head === 'z') return null; // genuinely out of room; caller falls back
  const wider = String.fromCharCode(head.charCodeAt(0) + 1);
  if (wider > 'a') digits.push(SMALLEST); else digits.pop();
  return wider + digits.join('');
}

function decrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i]!) - 1;
    if (next === -1) digits[i] = LARGEST;
    else { digits[i] = DIGITS[next]!; borrow = false; }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + LARGEST;
  if (head === 'A') return null;
  const wider = String.fromCharCode(head.charCodeAt(0) - 1);
  if (wider < 'Z') digits.push(LARGEST); else digits.pop();
  return wider + digits.join('');
}

/** A fraction strictly between `a` and `b`, where '' is 0 and null is 1. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new SortKeyError(`${a} is not before ${b}`);
  if (a.endsWith(SMALLEST) || (b !== null && b.endsWith(SMALLEST))) {
    throw new SortKeyError('fraction must not end in a zero digit');
  }

  if (b !== null) {
    // Share the common prefix and recurse on what differs.
    let n = 0;
    while ((a[n] ?? SMALLEST) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a === '' ? 0 : DIGITS.indexOf(a[0]!);
  const digitB = b === null ? DIGITS.length : DIGITS.indexOf(b[0]!);
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  }
  // Adjacent digits: descend a level.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * A key ordering strictly between `before` and `after`.
 * `null` means "no neighbour on that side".
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null) validate(before);
  if (after !== null) validate(after);
  if (before !== null && after !== null && before >= after) {
    throw new SortKeyError(`${before} is not before ${after}`);
  }

  if (before === null) {
    if (after === null) return 'a' + SMALLEST;
    const int = integerPart(after);
    const frac = after.slice(int.length);
    if (int === 'A' + SMALLEST.repeat(26)) return int + midpoint('', frac);
    if (int < after) return int;
    const smaller = decrementInteger(int);
    if (smaller === null) throw new SortKeyError('ran out of room below; rebalance');
    return smaller;
  }

  const intA = integerPart(before);
  const fracA = before.slice(intA.length);

  if (after === null) {
    const bigger = incrementInteger(intA);
    return bigger === null ? intA + midpoint(fracA, null) : bigger;
  }

  const intB = integerPart(after);
  const fracB = after.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);

  const bigger = incrementInteger(intA);
  if (bigger === null) throw new SortKeyError('ran out of room above; rebalance');
  return bigger < after ? bigger : intA + midpoint(fracA, null);
}

/** `n` keys in order between the two neighbours, balanced rather than chained. */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(before, after)];

  if (after === null) {
    let last = keyBetween(before, null);
    const out = [last];
    while (out.length < n) { last = keyBetween(last, null); out.push(last); }
    return out;
  }
  if (before === null) {
    let first = keyBetween(null, after);
    const out = [first];
    while (out.length < n) { first = keyBetween(null, first); out.push(first); }
    return out.reverse();
  }

  // Split down the middle so keys stay short instead of growing one digit per
  // insert, which is what happens if you just chain `keyBetween`.
  const half = Math.floor(n / 2);
  const mid = keyBetween(before, after);
  return [
    ...keysBetween(before, mid, half),
    mid,
    ...keysBetween(mid, after, n - half - 1),
  ];
}

/**
 * Is this a key this module produced?
 *
 * Exported so callers can assert it rather than assuming. Two encodings for one
 * column already happened once — the spike corpus minted zero-padded integers
 * while the domain module produced these — and the two sort differently, so
 * whichever was written second would have quietly reordered the manuscript.
 */
export function isValidKey(key: string): boolean {
  try { validate(key); return true; } catch { return false; }
}

/** Does this look like `globalRank()` made it? */
export function isValidGlobalRank(rank: string): boolean {
  let i = 0;
  let segments = 0;
  while (i < rank.length) {
    if (i + 2 > rank.length) return false;
    const hi = DIGITS.indexOf(rank[i]!);
    const lo = DIGITS.indexOf(rank[i + 1]!);
    if (hi < 0 || lo < 0) return false;
    const len = hi * DIGITS.length + lo;
    const key = rank.slice(i + 2, i + 2 + len);
    if (key.length !== len) return false;
    if (len > 0 && !isValidKey(key)) return false;
    i += 2 + len;
    segments += 1;
  }
  return segments > 0;
}

/** The first key in an empty list. */
export function firstKey(): string { return keyBetween(null, null); }

/** Keys for `n` items in a fresh list. */
export function initialKeys(n: number): string[] { return keysBetween(null, null, n); }

/**
 * Repeated inserts in the same gap lengthen keys. Long keys still sort
 * correctly — this is about storage and readability, not correctness, which is
 * why it is a maintenance action rather than something done automatically
 * mid-drag.
 */
export function needsRebalance(keys: readonly string[]): boolean {
  return keys.some((k) => k.length > REBALANCE_LENGTH);
}

/**
 * Fresh, evenly spaced keys for a list, preserving its current order.
 * Returns only the entries whose key actually changes, so the caller writes
 * the minimum number of rows.
 */
export function rebalance<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { item: T; key: string }[] {
  const ordered = [...items].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
  const fresh = initialKeys(ordered.length);
  const changed: { item: T; key: string }[] = [];
  ordered.forEach((item, i) => {
    if (keyOf(item) !== fresh[i]!) changed.push({ item, key: fresh[i]! });
  });
  return changed;
}

/**
 * `scene.global_rank` — the materialised part|chapter|scene triple that orders
 * the whole manuscript in one comparable string.
 *
 * Derived, never authored: recomputed on any structural move and rebuildable
 * wholesale ([doc 02 §9b](../../docs/02-data-model.md)). Segments are length-
 * prefixed so a short key can never sort above a longer one that shares its
 * prefix — `a0` before `a0V` is right, but naive concatenation with a separator
 * gets it wrong as soon as a separator character sorts below a digit.
 */
export function globalRank(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((p) => {
      const key = p ?? '';
      // Two-digit length prefix in base 62 handles keys far longer than any
      // rebalance would ever allow.
      const len = DIGITS[Math.floor(key.length / DIGITS.length)]! + DIGITS[key.length % DIGITS.length]!;
      return len + key;
    })
    .join('');
}
