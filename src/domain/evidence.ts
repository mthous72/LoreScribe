/**
 * Evidence verification — [doc 12 §3](../../docs/12-algorithms.md).
 *
 * *Any AI claim about the manuscript must cite a span that is verifiably
 * present in it.* Citation and source are normalised the same way — lowercase,
 * curly quotes straightened, dashes to hyphens, whitespace runs to one space —
 * and the citation must then be a substring of the source at least twelve
 * characters long, because shorter fragments match by accident.
 *
 * The normalisation keeps a map back to the original text, so a located quote
 * comes with the offsets of the span as the writer wrote it, not as the model
 * retyped it. A quote that cannot be located is the caller's to downgrade to
 * *uncertain*: never accepted, never silently dropped.
 */

export const MIN_EVIDENCE_CHARS = 12;

export interface Normalised {
  text: string;
  /** `map[i]` is the index in the original of the character that produced `text[i]`. */
  map: number[];
}

const QUOTES: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '―': '-', '−': '-',
};

export function normaliseEvidence(source: string): Normalised {
  let text = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (/\s/u.test(ch)) {
      if (!inSpace && text.length > 0) { text += ' '; map.push(i); }
      inSpace = true;
      continue;
    }
    inSpace = false;
    const folded = (QUOTES[ch] ?? ch).toLowerCase();
    for (const c of folded) { text += c; map.push(i); }
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}

export interface Located {
  start: number;
  end: number;
  /** The span as it stands in the source. */
  quote: string;
}

/** Where a claimed quote actually is in the prose, or null when it is not, or too short to trust. */
export function locateQuote(source: string, claimed: string): Located | null {
  const needle = normaliseEvidence(claimed).text;
  if (needle.length < MIN_EVIDENCE_CHARS) return null;
  const hay = normaliseEvidence(source);
  const at = hay.text.indexOf(needle);
  if (at === -1) return null;
  const start = hay.map[at]!;
  const end = hay.map[at + needle.length - 1]! + 1;
  return { start, end, quote: source.slice(start, end) };
}
