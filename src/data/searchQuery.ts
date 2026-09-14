/**
 * Turning what a writer typed into an FTS5 query.
 *
 * This exists because FTS5's `MATCH` takes a *query language*, not a string,
 * and handing it raw input is a bug rather than a shortcut. `don't` is an
 * unterminated string. `-` is a NOT operator with nothing after it. `AND`,
 * `OR`, `NEAR` and `*` are keywords. A bare `(` is a syntax error. Every one of
 * those throws, and a search box that dies on an apostrophe is not a search box.
 *
 * So nothing the writer types reaches the parser as syntax. Words are extracted
 * and re-quoted, which makes malformed input impossible by construction rather
 * than by a list of characters someone remembered to strip.
 */

/** A double-quoted run is a phrase: "the long hall" finds those words in order. */
const PHRASE = /"([^"]*)"/g;
/** Letters and numbers only. Everything else is punctuation, not search intent. */
const WORD = /[\p{L}\p{N}]+/gu;

const words = (s: string): string[] => s.match(WORD) ?? [];

export interface SearchQueryOptions {
  /**
   * Match the final word as a prefix, so results appear while the writer is
   * still typing it. Off for an explicit submit, where "cat" should not also
   * mean "catastrophe".
   */
  prefix?: boolean;
}

/**
 * An FTS5 expression, or null when there is nothing to search for.
 *
 * Null rather than an empty string: `MATCH ''` is itself a syntax error, so
 * "the writer has typed only punctuation" has to be a case the caller handles
 * rather than a query the caller sends.
 */
export function ftsQuery(input: string, options: SearchQueryOptions = {}): string | null {
  const terms: string[] = [];
  let rest = input;

  // Phrases first, so their words are not also emitted as loose terms.
  for (const match of input.matchAll(PHRASE)) {
    const inner = words(match[1] ?? '');
    if (inner.length) terms.push(`"${inner.join(' ')}"`);
    rest = rest.replace(match[0], ' ');
  }

  const loose = words(rest);
  loose.forEach((w, i) => {
    const last = i === loose.length - 1;
    // A quoted term followed by * is a prefix query. The quotes are what make
    // the word safe; the star is outside them, where FTS5 expects it.
    terms.push(options.prefix && last ? `"${w}"*` : `"${w}"`);
  });

  if (!terms.length) return null;
  // Implicit AND: every term must appear. A writer searching two words means
  // both, and OR would bury the result they wanted under everything containing
  // "the".
  return terms.join(' ');
}

/**
 * Markers for FTS5's `snippet()`, and the splitter that reads them back.
 *
 * Deliberately not `<b>` tags rendered as HTML: that would mean
 * `dangerouslySetInnerHTML` over a string built from the writer's own prose,
 * and there is no reason to introduce an HTML-injection path in order to make a
 * word bold. These are control characters precisely because prose never
 * contains them, so they cannot collide with the text being highlighted. The
 * caller renders the runs as elements.
 */
export const SNIPPET_OPEN = '';
export const SNIPPET_CLOSE = '';

export interface SnippetRun { text: string; hit: boolean }

export function parseSnippet(snippet: string): SnippetRun[] {
  const runs: SnippetRun[] = [];
  let rest = snippet;
  while (rest.length) {
    const open = rest.indexOf(SNIPPET_OPEN);
    if (open < 0) { runs.push({ text: rest, hit: false }); break; }
    if (open > 0) runs.push({ text: rest.slice(0, open), hit: false });
    const close = rest.indexOf(SNIPPET_CLOSE, open);
    // A snippet truncated mid-marker still renders; the tail is simply a hit.
    if (close < 0) { runs.push({ text: rest.slice(open + 1), hit: true }); break; }
    runs.push({ text: rest.slice(open + 1, close), hit: true });
    rest = rest.slice(close + 1);
  }
  return runs.filter((r) => r.text.length > 0);
}
