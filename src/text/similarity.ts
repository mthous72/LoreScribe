/**
 * Sequence similarity, as Python's `difflib.SequenceMatcher.ratio()` computes it.
 *
 * Written fresh against the specification in docs/12 §1.3 and §2.3, which name
 * that algorithm specifically. Two call sites depend on the exact numbers, so a
 * rough approximation would silently shift both thresholds:
 *   - repetition guard: flag a scene opening at ratio >= 0.6
 *   - sanitiser: drop an echoed summary line at ratio >= 0.7
 *
 * The ratio is `2 * M / T`, where M is the total size of the matching blocks and
 * T is the combined length of both sequences. Note that M comes from a recursive
 * longest-matching-block decomposition, NOT from the longest common subsequence
 * — the two differ, and the thresholds above were calibrated against the former.
 *
 * difflib's "autojunk" heuristic is deliberately not implemented: it only
 * engages for sequences of 200 or more elements, and both call sites compare
 * single sentences. If this is ever pointed at whole scenes, revisit that.
 */

export interface MatchingBlock {
  aStart: number;
  bStart: number;
  size: number;
}

/**
 * The longest matching block in `a[aLo:aHi]` / `b[bLo:bHi]`.
 *
 * Ties break toward the earliest position in `a`, then the earliest in `b` —
 * difflib's own tie-breaking, which makes results stable and reproducible.
 */
function longestMatch<T>(
  a: readonly T[], b: readonly T[],
  aLo: number, aHi: number, bLo: number, bHi: number,
  bIndex: Map<T, number[]>,
): MatchingBlock {
  let bestA = aLo, bestB = bLo, bestSize = 0;

  // j2len[j] = length of the longest match ending at a[i], b[j]. Rebuilt per row
  // so the whole thing stays O(n*m) worst case without an n*m allocation.
  let j2len = new Map<number, number>();

  for (let i = aLo; i < aHi; i++) {
    const newJ2len = new Map<number, number>();
    for (const j of bIndex.get(a[i]!) ?? []) {
      if (j < bLo) continue;
      if (j >= bHi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newJ2len.set(j, k);
      if (k > bestSize) {
        bestA = i - k + 1;
        bestB = j - k + 1;
        bestSize = k;
      }
    }
    j2len = newJ2len;
  }

  return { aStart: bestA, bStart: bestB, size: bestSize };
}

/** All matching blocks, in order, via the same recursive decomposition. */
export function matchingBlocks<T>(a: readonly T[], b: readonly T[]): MatchingBlock[] {
  const bIndex = new Map<T, number[]>();
  b.forEach((el, j) => {
    const at = bIndex.get(el);
    if (at) at.push(j);
    else bIndex.set(el, [j]);
  });

  const blocks: MatchingBlock[] = [];
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];

  while (queue.length) {
    const [aLo, aHi, bLo, bHi] = queue.pop()!;
    const m = longestMatch(a, b, aLo, aHi, bLo, bHi, bIndex);
    if (m.size === 0) continue;
    blocks.push(m);
    // Recurse either side of the block found.
    if (aLo < m.aStart && bLo < m.bStart) queue.push([aLo, m.aStart, bLo, m.bStart]);
    if (m.aStart + m.size < aHi && m.bStart + m.size < bHi) {
      queue.push([m.aStart + m.size, aHi, m.bStart + m.size, bHi]);
    }
  }

  blocks.sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
  return blocks;
}

/** Similarity of two sequences in [0, 1]. Two empty sequences are identical. */
export function sequenceRatio<T>(a: readonly T[], b: readonly T[]): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  const matched = matchingBlocks(a, b).reduce((n, m) => n + m.size, 0);
  return (2 * matched) / total;
}

/** Similarity of two strings, compared character by character. */
export function stringRatio(a: string, b: string): number {
  return sequenceRatio([...a], [...b]);
}
