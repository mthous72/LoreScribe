import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ftsQuery, parseSnippet, SNIPPET_OPEN, SNIPPET_CLOSE } from './searchQuery';

/**
 * The query builder, and then the same strings run through a real FTS5 parser.
 *
 * Asserting the generated text is worth little on its own — the question is
 * whether SQLite accepts it. The second block answers that by executing every
 * case, including the ones that throw if the input reaches the parser unquoted.
 */

describe('building a query', () => {
  it('quotes each word, and prefixes the last one while typing', () => {
    expect(ftsQuery('grey warden', { prefix: true })).toBe('"grey" "warden"*');
    expect(ftsQuery('grey warden')).toBe('"grey" "warden"');
  });

  it('keeps a quoted run together as a phrase', () => {
    expect(ftsQuery('"the long hall"')).toBe('"the long hall"');
    expect(ftsQuery('"long hall" ilva')).toBe('"long hall" "ilva"');
  });

  it('returns null when there is nothing to search for', () => {
    // MATCH '' is itself a syntax error, so this has to be a case the caller
    // handles rather than a query the caller sends.
    for (const empty of ['', '   ', '-', '()', '""', '***', '"  "']) {
      expect(ftsQuery(empty), JSON.stringify(empty)).toBeNull();
    }
  });

  it('strips the operators rather than trusting them', () => {
    // A writer typing AND means the word, not the operator.
    expect(ftsQuery('cats AND dogs')).toBe('"cats" "AND" "dogs"');
    expect(ftsQuery('ilva NEAR hall')).toBe('"ilva" "NEAR" "hall"');
    expect(ftsQuery('-warden')).toBe('"warden"');
  });
});

describe('what SQLite actually accepts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61')");
  db.exec("INSERT INTO t (body) VALUES ('The Grey Warden did not answer. Ilva waited.')");

  const run = (q: string) => {
    const stmt = db.prepare('SELECT COUNT(*) AS n FROM t WHERE t MATCH ?');
    return (stmt.get(q) as { n: number }).n;
  };

  // Each of these is a real thing a writer types, and each is a syntax error if
  // it reaches the FTS5 parser unquoted.
  const hostile = [
    "don't", 'foo-bar', 'AND', 'OR', 'NOT', 'NEAR', '*', '"', '""', '((',
    'a AND', 'warden*', 'ilva OR', '^start', 'a:b', '{x}', 'café',
    "it's a -trap", '"unclosed', 'NEAR(a b, 5)', 'ilva   ', '   ',
  ];

  it.each(hostile)('accepts %j without throwing', (input) => {
    const q = ftsQuery(input, { prefix: true });
    if (q === null) return;             // nothing to search for is a valid answer
    expect(() => run(q), `generated: ${q}`).not.toThrow();
  });

  it('proves the danger is real — raw input does throw', () => {
    // If this ever stops throwing, FTS5 has changed and the quoting can be
    // re-examined. Until then it is the reason this module exists.
    expect(() => run("don't")).toThrow();
    expect(() => run('a AND')).toThrow();
  });

  it('still finds what the writer meant', () => {
    expect(run(ftsQuery('warden')!)).toBe(1);
    expect(run(ftsQuery('grey warden')!)).toBe(1);
    expect(run(ftsQuery('"grey warden"')!)).toBe(1);
    expect(run(ftsQuery('"warden grey"')!)).toBe(0);     // a phrase is ordered
    expect(run(ftsQuery('war', { prefix: true })!)).toBe(1);
    expect(run(ftsQuery('war')!)).toBe(0);               // without the star, a whole word
    expect(run(ftsQuery('warden dragon')!)).toBe(0);     // both words, not either
  });
});

describe('snippets', () => {
  it('splits on the markers instead of rendering HTML', () => {
    const s = `the ${SNIPPET_OPEN}warden${SNIPPET_CLOSE} did not answer`;
    expect(parseSnippet(s)).toEqual([
      { text: 'the ', hit: false },
      { text: 'warden', hit: true },
      { text: ' did not answer', hit: false },
    ]);
  });

  it('survives a snippet truncated mid-marker', () => {
    expect(parseSnippet(`a ${SNIPPET_OPEN}b`)).toEqual([
      { text: 'a ', hit: false }, { text: 'b', hit: true },
    ]);
    expect(parseSnippet('no markers at all')).toEqual([{ text: 'no markers at all', hit: false }]);
    expect(parseSnippet('')).toEqual([]);
  });
});
