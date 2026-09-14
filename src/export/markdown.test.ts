import { describe, it, expect } from 'vitest';
import {
  manuscriptMarkdown, manuscriptText, entityMarkdown, factsMarkdown, cell, fileName, uniquely,
  type BookForExport,
} from './markdown';

/** The readable export. Fixtures invented — D14. */

const BOOK: BookForExport = {
  title: 'Ashfall',
  parts: [
    {
      title: null,
      chapters: [{
        title: 'Arrival',
        scenes: [
          { title: 'The harbour', contentText: 'The harbour was empty.', wordCount: 4 },
          { title: 'The gate', contentText: null, wordCount: 0 },
        ],
      }],
    },
    {
      title: 'Part Two',
      chapters: [{ title: 'Departure', scenes: [
        { title: 'Last light', contentText: 'She left at dawn.', wordCount: 4 },
      ] }],
    },
  ],
};

describe('the manuscript', () => {
  it('nests book, part, chapter and scene', () => {
    const md = manuscriptMarkdown(BOOK);
    expect(md).toContain('# Ashfall');
    expect(md).toContain('## Part Two');
    expect(md).toContain('### Arrival');
    expect(md).toContain('#### The harbour');
  });

  it('keeps chapters at one level whether or not the book has parts', () => {
    // A book that gains a part later must not reshuffle every heading in the
    // file, which is what a diff of the export would otherwise show.
    const md = manuscriptMarkdown(BOOK);
    expect(md).toContain('### Arrival');
    expect(md).toContain('### Departure');
  });

  it('says an empty scene is empty rather than skipping it', () => {
    // A writer checking an export against their outline needs the gaps to show.
    expect(manuscriptMarkdown(BOOK)).toContain('*(nothing written yet)*');
  });

  it('offers the separator a finished manuscript uses instead of scene titles', () => {
    const md = manuscriptMarkdown(BOOK, { sceneTitles: false });
    expect(md).not.toContain('#### The harbour');
    expect(md).toContain('***');
  });

  it('ends with exactly one newline', () => {
    expect(manuscriptMarkdown(BOOK).endsWith('.\n')).toBe(true);
  });
});

describe('plain text', () => {
  it('has no Markdown left in it at all', () => {
    // Not the same file with the hashes stripped: a line reading `# Arrival` in
    // a plain text file is a leftover, not a heading.
    const text = manuscriptText(BOOK);
    expect(text).not.toMatch(/^#/mu);
    expect(text).not.toContain('***');
    expect(text).toContain('ASHFALL');
    expect(text).toContain('* * *');
  });

  it('keeps the prose itself untouched', () => {
    expect(manuscriptText(BOOK)).toContain('The harbour was empty.');
  });
});

describe('a codex entry', () => {
  const ILVA = {
    name: 'Ilva', typeKey: 'character', summary: 'The heir who waits.',
    description: 'She keeps the seal.', importance: 'major', status: 'alive',
    aliases: ['Ilva Sarn'], attributes: { want: 'the throne.', 'beat path': 'she waits.' },
  };

  it('writes the fields in the shape the importer reads back', () => {
    const md = entityMarkdown(ILVA);
    expect(md).toContain('# Ilva');
    expect(md).toContain('Also known as: Ilva Sarn');
    expect(md).toContain('Importance: major');
    expect(md).toContain('## Attributes');
    // Capitalised back the way a writer would have typed it.
    expect(md).toContain('Want: the throne.');
    expect(md).toContain('Beat path: she waits.');
  });

  it('leaves out what is not there rather than writing empty labels', () => {
    const md = entityMarkdown({
      ...ILVA, summary: null, status: null, aliases: [], attributes: {},
    });
    expect(md).not.toContain('Also known as');
    expect(md).not.toContain('Status:');
    expect(md).not.toContain('## Attributes');
  });
});

describe('the knowledge table', () => {
  it('writes facts down the rows and who knows them across', () => {
    const md = factsMarkdown([
      { statement: 'She is the heir', knownBy: { Ilva: 'yes' } },
    ], ['Ilva', 'Renn']);
    expect(md).toContain('| Fact | Ilva | Renn |');
    expect(md).toContain('| She is the heir | yes | no |');
  });

  it('escapes a pipe rather than shifting every cell after it', () => {
    // Silent corruption otherwise: the table still renders, with the columns
    // one out from the row where it happened.
    expect(cell('she left | or was taken')).toBe('she left \\| or was taken');
    expect(cell('two\nlines')).toBe('two lines');
  });

  it('says so when there is nothing to say', () => {
    expect(factsMarkdown([], [])).toContain('No facts recorded yet');
  });
});

describe('file names', () => {
  it('makes a readable, safe name from a title', () => {
    expect(fileName('The Long Hall!')).toBe('the-long-hall');
    expect(fileName('  ')).toBe('untitled');
  });

  it('numbers repeats instead of overwriting them', () => {
    // Two characters called Cal is ordinary; losing one of them to a file name
    // collision is not.
    const taken = new Set<string>();
    expect([uniquely('cal', taken), uniquely('cal', taken), uniquely('cal', taken)])
      .toEqual(['cal', 'cal-2', 'cal-3']);
  });
});
