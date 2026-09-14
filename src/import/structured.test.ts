import { describe, it, expect } from 'vitest';
import { parseCsvRows, parseCsv, parseJson } from './structured';

/**
 * CSV and JSON.
 *
 * The CSV cases are the ones a naive `split(',')` gets wrong, because that
 * failure is silent: it produces a table of the right shape with the wrong
 * contents, which survives a review that is only looking at the shape.
 */

describe('CSV', () => {
  it('reads a quoted field containing the delimiter, a newline and a quote', () => {
    const rows = parseCsvRows('a,"b,still b","line\none","say ""hi"""');
    expect(rows).toEqual([['a', 'b,still b', 'line\none', 'say "hi"']]);
  });

  it('takes the first row as a header when it looks like one', () => {
    const doc = parseCsv('cast.csv', 'Name,Role\nIlva,heir\nRenn,clerk\n');
    expect(doc.root.tables[0]).toEqual({
      columns: ['Name', 'Role'],
      rows: [['Ilva', 'heir'], ['Renn', 'clerk']],
    });
  });

  it('keeps every row when the first one is not a header', () => {
    // A repeated or empty cell is not a header, and losing the first row of
    // data to a wrong guess is the expensive direction of this mistake.
    const doc = parseCsv('x.csv', 'Ilva,Ilva\nRenn,clerk\n');
    expect(doc.root.tables[0]).toEqual({ columns: [], rows: [['Ilva', 'Ilva'], ['Renn', 'clerk']] });
  });

  it('reads tabs when the file is really a TSV', () => {
    expect(parseCsv('x.csv', 'Name\tRole\nIlva\their\n').root.tables[0]?.columns)
      .toEqual(['Name', 'Role']);
  });

  it('treats a trailing newline as punctuation, not an empty record', () => {
    expect(parseCsvRows('a,b\n')).toEqual([['a', 'b']]);
    expect(parseCsvRows('')).toEqual([]);
  });
});

describe('JSON', () => {
  it('reads scalars as fields and nested objects as sections', () => {
    const root = parseJson('x.json', JSON.stringify({
      title: 'Ashfall', year: 3, draft: true,
      cover: { colour: 'grey' },
    })).root;
    expect(root.fields).toEqual([
      { key: 'title', value: 'Ashfall' },
      { key: 'year', value: '3' },
      { key: 'draft', value: 'true' },
    ]);
    expect(root.children[0]).toMatchObject({
      heading: 'cover', fields: [{ key: 'colour', value: 'grey' }],
    });
  });

  it('reads an array of records as a table, because that is what it is', () => {
    const root = parseJson('cast.json', JSON.stringify({
      cast: [{ name: 'Ilva', role: 'heir' }, { name: 'Renn' }],
    })).root;
    const table = root.children[0]?.tables[0];
    // A key missing from one record is a blank cell, not a shorter row.
    expect(table).toEqual({ columns: ['name', 'role'], rows: [['Ilva', 'heir'], ['Renn', '']] });
  });

  it('keeps an array of scalars as text rather than pretending it is a grid', () => {
    const root = parseJson('x.json', JSON.stringify({ tags: ['grim', 'coastal'] })).root;
    expect(root.children[0]?.text).toBe('grim\ncoastal');
  });

  it('keeps an empty value, because a blank status is not no status', () => {
    expect(parseJson('x.json', '{"status":""}').root.fields)
      .toEqual([{ key: 'status', value: '' }]);
  });

  it('reads a top-level array as one table', () => {
    expect(parseJson('x.json', '[{"a":1},{"a":2}]').root.tables[0])
      .toEqual({ columns: ['a'], rows: [['1'], ['2']] });
  });

  it('does not infer meaning from a key name', () => {
    // A `characters` array becomes a table called "characters", not characters.
    // The rules that guess live in plan.ts where they can be overridden; a
    // parser that guessed would decide it somewhere nobody can reach.
    const root = parseJson('x.json', '{"characters":[{"name":"Ilva"}]}').root;
    expect(root.children[0]?.heading).toBe('characters');
    expect(root.children[0]?.tables).toHaveLength(1);
  });
});

describe('choosing a parser', () => {
  it('goes by the extension, because the writer named the file', async () => {
    const { formatFor } = await import('./read');
    expect(formatFor('a/b/notes.MD')).toBe('markdown');
    expect(formatFor('cast.tsv')).toBe('csv');
    expect(formatFor('bible.docx')).toBe('docx');
    // No extension carries no information, and an extensionless file is almost
    // always text.
    expect(formatFor('README')).toBe('text');
    expect(formatFor('scan.pdf')).toBeNull();
  });

  it('does not treat a dotfile’s name as an extension', async () => {
    const { formatFor } = await import('./read');
    expect(formatFor('.gitignore')).toBe('text');
  });
});
