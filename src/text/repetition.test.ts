import { describe, it, expect } from 'vitest';
import {
  tokenise, buildBanList, renderBanList, checkViolations, overuseReport, isEmpty,
} from './repetition';

describe('tokenising', () => {
  it('never lets an n-gram cross a sentence or paragraph boundary', () => {
    // docs/12 §1.1 calls this one of the cheapest correctness wins and easy to
    // omit: without it, the last words of one sentence and the first of the
    // next form phantom phrases that get banned.
    const t = tokenise('The rain fell. Sheets of water covered it.\n\nHe waited.');
    expect(t.sentences).toEqual([
      ['the', 'rain', 'fell'],
      ['sheets', 'of', 'water', 'covered', 'it'],
      ['he', 'waited'],
    ]);
  });

  it('strips headings and scene markers before analysing', () => {
    const t = tokenise('## Chapter One\nScene 3: The Long Hall\nThe rain fell.');
    expect(t.sentences).toEqual([['the', 'rain', 'fell']]);
  });

  it('finds proper nouns mid-sentence but not sentence-initial words', () => {
    const t = tokenise('Kaelen woke early. The smith met Kaelen at the forge.');
    expect(t.properNouns.has('kaelen')).toBe(true);
    expect(t.properNouns.has('the')).toBe(false);  // sentence-initial capital
    expect(t.properNouns.has('smith')).toBe(false);
  });
});

describe('ban list', () => {
  it('NEVER contains a proper noun', () => {
    // The property doc 08 names explicitly. A guard that forbids the
    // protagonist's name is worse than no guard at all.
    const prose = [
      'Kaelen crossed the yard. Kaelen crossed the yard again.',
      'Kaelen crossed the yard a third time, and Bren watched Kaelen cross the yard.',
      'Bren said nothing. Bren said nothing at all. Bren said nothing again.',
    ].join('\n\n');
    const ban = buildBanList(prose);
    for (const phrase of ban.phrases) {
      expect(phrase, `"${phrase}" contains a name`).not.toMatch(/kaelen|bren/);
    }
    expect(ban.words).not.toContain('kaelen');
    expect(ban.words).not.toContain('bren');
  });

  it('merges staggered fragments into one phrase', () => {
    // The other property doc 08 names. The 5-gram window chops a longer repeat
    // into overlapping pieces; unmerged, the list is three-quarters duplicates.
    const sentence = 'A heavy sheet of corrugated plastic rattled somewhere behind the wall.';
    const ban = buildBanList([sentence, sentence, sentence].join('\n\n'));
    const merged = ban.phrases.find((p) => p.includes('corrugated'));
    expect(merged).toBeDefined();
    expect(merged).toContain('heavy sheet of corrugated plastic');
    // And the fragments it was built from are not also present.
    expect(ban.phrases.filter((p) => p.includes('corrugated'))).toHaveLength(1);
  });

  it('qualifies a short loud repeat on the three-occurrence rule', () => {
    // count >= 3 with >= 1 content word, per §1.1.
    const prose = Array.from({ length: 3 }, (_, i) => `She flinched as if burned. Number ${i} ended it.`).join('\n\n');
    const ban = buildBanList(prose);
    expect(ban.phrases.some((p) => p.includes('as if burned'))).toBe(true);
  });

  it('does not ban a phrase that occurs only once', () => {
    const ban = buildBanList('A heavy sheet of corrugated plastic rattled behind the wall.');
    expect(ban.phrases).toEqual([]);
  });

  it('caps the list so it cannot eat the context budget', () => {
    const noisy = Array.from({ length: 40 }, (_, i) =>
      `Distinct phrase number ${i} repeated. Distinct phrase number ${i} repeated.`).join('\n\n');
    expect(buildBanList(noisy).phrases.length).toBeLessThanOrEqual(12);
  });

  it('flags overused single words, which the phrase detector cannot see', () => {
    const prose = Array.from({ length: 12 }, (_, i) => `The light was different that ${i} time.`).join('\n\n');
    const ban = buildBanList(prose);
    expect(ban.words).toContain('light');
    expect(ban.words).not.toContain('the');   // stopword
    expect(ban.words).not.toContain('was');   // stopword
  });

  it('keeps only the most recent scene openings', () => {
    const openings = Array.from({ length: 10 }, (_, i) => `Opening number ${i}.`);
    expect(buildBanList('', { recentOpenings: openings }).openings).toEqual(openings.slice(-6));
  });
});

describe('rendering', () => {
  it('emits nothing when nothing qualifies', () => {
    const ban = buildBanList('One clean sentence with no repetition at all.');
    expect(isEmpty(ban)).toBe(true);
    expect(renderBanList(ban)).toBe('');
  });

  it('states bans as constraints, not preferences', () => {
    const ban = { phrases: ['heavy sheet of corrugated plastic'], words: ['light'], openings: ['Dawn came.'] };
    const rendered = renderBanList(ban);
    expect(rendered).toContain('FORBIDDEN PHRASES');
    expect(rendered).toContain('do not use');
    expect(rendered).toContain('heavy sheet of corrugated plastic');
    expect(rendered).toContain('OVERUSED WORDS');
    expect(rendered).toContain('RECENT SCENE OPENINGS');
  });
});

describe('post-generation check', () => {
  const ban = { phrases: ['heavy sheet of corrugated plastic'], words: ['shimmered'], openings: ['Dawn came slowly over the yard.'] };

  it('catches a banned phrase regardless of surrounding punctuation or case', () => {
    const v = checkViolations('Behind it, a Heavy Sheet of Corrugated Plastic — rattling.', ban);
    expect(v).toEqual([{ kind: 'phrase', value: 'heavy sheet of corrugated plastic', detail: 1 }]);
  });

  it('allows one use of an overused word but not two', () => {
    expect(checkViolations('The air shimmered.', ban)).toEqual([]);
    expect(checkViolations('The air shimmered. The road shimmered too.', ban))
      .toEqual([{ kind: 'word', value: 'shimmered', detail: 2 }]);
  });

  it('flags an opening that is too close to a recent one', () => {
    const v = checkViolations('Dawn came slowly over the field.', ban);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe('opening');
    expect(v[0]!.detail).toBeGreaterThanOrEqual(0.6);
  });

  it('passes an opening that starts from a different image', () => {
    expect(checkViolations('Rust had eaten through the hinge.', ban)).toEqual([]);
  });

  it('returns nothing for clean prose', () => {
    expect(checkViolations('A perfectly ordinary sentence.', ban)).toEqual([]);
  });
});

describe('revision report', () => {
  it('counts occurrences so the writer can leave one and reword the rest', () => {
    const sentence = 'A heavy sheet of corrugated plastic rattled somewhere behind the wall.';
    const rows = overuseReport([sentence, sentence, sentence].join('\n\n'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.occurrences).toBeGreaterThanOrEqual(3);
    expect(rows).toEqual([...rows].sort((a, b) => b.occurrences - a.occurrences || a.phrase.localeCompare(b.phrase)));
  });
});
