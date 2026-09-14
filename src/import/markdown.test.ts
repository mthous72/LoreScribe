import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseText } from './markdown';
import { walk, field, subtreeText, type SourceNode } from './source';

/**
 * The Markdown parser.
 *
 * Every fixture here is invented. The bible this was built against never enters
 * this repository, in any branch, at any point in its history — D14 — so what is
 * tested is the *shape* it has, written out fresh: a character file with a
 * template block, a who-knows-what table, a document that skips heading levels.
 *
 * The properties worth asserting are the ones a writer would notice: that
 * nesting follows the headings they wrote, that a field is a field and a
 * sentence is not, and that nothing is silently dropped.
 */

const tree = (md: string): SourceNode => parseMarkdown('x.md', md).root;
const headings = (md: string) =>
  [...walk(tree(md))].slice(1).map(({ node }) => `${node.depth}:${node.heading}`);
const find = (md: string, heading: string): SourceNode => {
  for (const { node } of walk(tree(md))) if (node.heading === heading) return node;
  throw new Error(`no section ${heading}`);
};

describe('sections', () => {
  it('nests by heading level', () => {
    expect(headings('# Book\n## Part\n### Chapter\n## Other'))
      .toEqual(['1:Book', '2:Part', '3:Chapter', '2:Other']);
  });

  it('nests a skipped level rather than refusing the file', () => {
    // Real documents skip levels constantly. Erroring would be the parser
    // having an opinion about the writer's formatting.
    expect(headings('# Top\n#### Deep')).toEqual(['1:Top', '4:Deep']);
  });

  it('attaches a heading that has no parent to the document itself', () => {
    expect(headings('### Orphan')).toEqual(['3:Orphan']);
  });

  it('keeps a section’s own prose separate from its children’s', () => {
    const node = find('# One\nMine.\n\n## Two\nTheirs.', 'One');
    expect(node.text).toBe('Mine.');
    // The dossier a writer means by "this character" is the whole subtree.
    expect(subtreeText(node)).toContain('Theirs.');
  });

  it('gives every node a positional id, so a reparse lands on the same node', () => {
    // A mapping the writer made by hand has to survive them fixing a typo and
    // importing again. Random ids would lose it every time.
    const ids = (md: string) => [...walk(tree(md))].map(({ node }) => node.id);
    expect(ids('# A\n## B\n## C\n# D')).toEqual(['', '0', '0.0', '0.1', '1']);
    expect(ids('# A\n## B\n## C\n# D')).toEqual(ids('# A\nedited\n## B\n## C\n# D'));
  });
});

describe('setext headings and rules', () => {
  it('reads an underlined line as a heading', () => {
    expect(headings('Title\n=====\nBody\n\nSub\n---')).toEqual(['1:Title', '2:Sub']);
  });

  it('treats the same characters after a blank line as a divider, not a heading', () => {
    // One line of context is the whole difference, and a bible that uses `---`
    // as a separator sprouts spurious headings without it.
    expect(headings('# Real\n\n---\n\nprose')).toEqual(['1:Real']);
    expect(find('# Real\n\n---\n\nprose', 'Real').text).toBe('prose');
  });
});

describe('fields', () => {
  it('reads the key/value lines that make a template a template', () => {
    const node = find('# Ilva\n## Arc\nWant: the seal.\nNeed: to be seen.\n', 'Arc');
    expect(node.fields).toEqual([
      { key: 'Want', value: 'the seal.' },
      { key: 'Need', value: 'to be seen.' },
    ]);
  });

  it('accepts a bolded key on sight, and a bulleted one', () => {
    const node = find('# X\n- **Eye colour**: grey\n**Age**: 34\n', 'X');
    expect(node.fields.map((f) => f.key)).toEqual(['Eye colour', 'Age']);
  });

  it('does not turn dialogue into a field', () => {
    // The loose rule — anything before a colon — makes a bible full of dialogue
    // into a bible full of nonsense fields.
    const node = find('# X\nShe turned and said: nothing at all.\n', 'X');
    expect(node.fields).toEqual([]);
    expect(node.text).toContain('said: nothing');
  });

  it('needs both signals, because neither holds alone', () => {
    const fields = (line: string) => find(`# X\n${line}\n`, 'X').fields.map((f) => f.key);
    // Short enough to pass the length test; "said" gives it away.
    expect(fields('She said: nothing at all.')).toEqual([]);
    // No clause word in it; too long to be a label.
    expect(fields('The thing about the harbour: it was empty.')).toEqual([]);
    // A real three-word label with a leading article survives both.
    expect(fields('The live split: she has the scar.')).toEqual(['The live split']);
  });

  it('lets a bolded key overrule both tests, because the writer said so', () => {
    expect(find('# X\n**She turned and said**: nothing.\n', 'X').fields)
      .toEqual([{ key: 'She turned and said', value: 'nothing.' }]);
  });

  it('matches a key regardless of how it was capitalised or decorated', () => {
    // A bible written over two years does not capitalise the same word twice.
    const node = find('# X\n**WANT**: the seal.\n', 'X');
    expect(field(node, 'want')).toBe('the seal.');
    expect(field(node, 'Need', 'want')).toBe('the seal.');
    expect(field(node, 'missing')).toBeNull();
  });

  it('reads front matter as fields', () => {
    const root = tree('---\ntitle: Ashfall\nstatus: drafting\n---\n# Book\n');
    expect(root.fields).toEqual([
      { key: 'title', value: 'Ashfall' },
      { key: 'status', value: 'drafting' },
    ]);
    expect(root.children[0]?.heading).toBe('Book');
  });

  it('leaves an unterminated front-matter fence as ordinary content', () => {
    const root = tree('---\nnot really front matter\n# Book\n');
    expect(root.fields).toEqual([]);
    expect(root.children[0]?.heading).toBe('Book');
  });
});

describe('tables', () => {
  const KNOWN = [
    '# Who knows',
    '| Fact | Ilva | Renn |',
    '|---|---|---|',
    '| She is the heir | yes | no |',
    '| The seal is a fake | yes | suspects |',
  ].join('\n');

  it('reads the grid, header and rows', () => {
    // The highest-value shape in a bible: rows are facts, columns are who
    // knows them, which is very nearly this schema already.
    const [table] = find(KNOWN, 'Who knows').tables;
    expect(table?.columns).toEqual(['Fact', 'Ilva', 'Renn']);
    expect(table?.rows).toEqual([
      ['She is the heir', 'yes', 'no'],
      ['The seal is a fake', 'yes', 'suspects'],
    ]);
  });

  it('needs the delimiter row, so a pipe in prose is prose', () => {
    const node = find('# X\n| this is just a line with pipes |\nmore prose\n', 'X');
    expect(node.tables).toEqual([]);
    expect(node.text).toContain('pipes');
  });
});

describe('code fences', () => {
  it('leaves structure inside a fence alone', () => {
    // A table in a code block is one the writer is showing, not keeping.
    const node = find('# X\n```\n| a | b |\n|---|---|\n# not a heading\n```\nafter\n', 'X');
    expect(node.tables).toEqual([]);
    expect(node.children).toEqual([]);
    expect(node.text).toContain('# not a heading');
  });
});

describe('nothing is silently dropped', () => {
  it('keeps an empty document as an empty document', () => {
    expect(tree('')).toMatchObject({ text: '', fields: [], tables: [], children: [] });
  });

  it('treats plain text as Markdown that happens to use none of it', () => {
    // A .txt with a `Want:` line in it should not lose the field for want of a
    // file extension.
    const doc = parseText('note.txt', 'Want: a room.\n\nJust prose.');
    expect(doc.format).toBe('text');
    expect(doc.root.fields).toEqual([{ key: 'Want', value: 'a room.' }]);
    expect(doc.root.text).toBe('Just prose.');
  });
});
