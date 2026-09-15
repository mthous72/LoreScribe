import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdown';
import { walk } from './source';
import {
  suggestAll, absorbedFields, defaultFieldTarget, nameKey,
  type SuggestContext, type Suggestion,
} from './plan';

/**
 * The mapping rules.
 *
 * Fixtures are invented (D14), written to the shapes a real bible has: a file
 * per character, a file holding several, a who-knows-what table, and a pile of
 * material no rule should claim to understand.
 *
 * The property that matters most is the negative one — that nothing is claimed
 * by a rule that did not actually recognise it. A suggestion engine that
 * guesses generously produces a codex the writer has to clean up, which is
 * worse than the blank one they started with.
 */

const TYPES = new Set(['character', 'location', 'faction', 'item', 'event']);
const context = (existing: SuggestContext['existing'] = new Map()): SuggestContext =>
  ({ existing, types: TYPES });

const run = (files: Record<string, string>, ctx = context()): Suggestion[] =>
  suggestAll(Object.entries(files).map(([path, md]) => parseMarkdown(path, md)), ctx);

const shape = (s: Suggestion[]) =>
  s.map((x) => `${x.label}:${x.destination.kind}${'typeKey' in x.destination ? `/${x.destination.typeKey}` : ''}`);

describe('one file, one entry', () => {
  const JERU = '# Jeru\nHe keeps the door.\n\n## Arc\nWant: keep the door.\nLie: I can rent the book.\n';

  it('reads a file under characters/ as a character', () => {
    expect(shape(run({ 'characters/jeru.md': JERU }))).toEqual(['Jeru:entity/character']);
  });

  it('absorbs the template section instead of reporting it as skipped', () => {
    // The section is not a thing of its own; it is part of the character. Left
    // as a separate row it would tell the writer their `Want:` was being
    // dropped, which is both wrong and the most alarming thing the list could say.
    const suggestions = run({ 'characters/jeru.md': JERU });
    expect(suggestions).toHaveLength(1);
    expect(suggestions.map((s) => s.destination.kind)).not.toContain('skip');
  });

  it('carries the nested fields onto the entity', () => {
    const root = parseMarkdown('characters/jeru.md', JERU).root;
    const jeru = [...walk(root)].find(({ node }) => node.heading === 'Jeru')!.node;
    expect(absorbedFields(jeru).map((f) => f.key)).toEqual(['Want', 'Lie']);
  });

  it('keeps two same-named fields apart by the section they came from', () => {
    // A bible with `Want:` under both Arc and Voice has two fields, not one
    // silently overwriting the other.
    const root = parseMarkdown('characters/x.md',
      '# X\n## Arc\nWant: the seal.\n## Voice\nWant: to be heard.\n').root;
    const x = [...walk(root)].find(({ node }) => node.heading === 'X')!.node;
    expect(absorbedFields(x)).toEqual([
      { key: 'Want', value: 'the seal.' },
      { key: 'Voice Want', value: 'to be heard.' },
    ]);
  });

  it('names the type from the folder, and only a type the project has', () => {
    expect(shape(run({ 'places/harbour.md': '# Harbour\nEmpty.\n' })))
      .toEqual(['Harbour:entity/location']);
    // A project without a faction type never gets a faction proposed at it.
    const narrow = { existing: new Map(), types: new Set(['character']) };
    expect(shape(run({ 'factions/guild.md': '# Guild\nThey trade.\n' }, narrow)))
      .toEqual(['Guild:skip']);
  });
});

describe('one file, several entries', () => {
  const MANY = [
    '# Supporting Characters', 'The ones who are not the book.',
    '### Cal', 'He apologises.',
    '### Veck', 'He does not.',
    '### Juno', 'She is easy about it.',
    '## What each hour is for', 'Craft notes, not a person.',
  ].join('\n');

  it('reads repeated sections as a list of things', () => {
    // Both layouts are ordinary ways to keep a bible and neither is more
    // correct, so the shape decides rather than a convention nobody agreed to.
    expect(shape(run({ 'characters/supporting.md': MANY }))).toEqual([
      'Supporting Characters:skip',
      'Cal:entity/character',
      'Veck:entity/character',
      'Juno:entity/character',
      'What each hour is for:skip',
    ]);
  });

  it('needs two of them, so one child section does not make a file a list', () => {
    expect(shape(run({ 'characters/one.md': '# Ilva\nA person.\n### Voice\nDry.\n' })))
      .toEqual(['Ilva:entity/character']);
  });
});

describe('the knowledge table', () => {
  const TABLE = [
    '# Who knows what', '',
    '| Fact | Ilva | Renn |', '|---|---|---|',
    '| She is the heir | yes | no |',
  ].join('\n');

  it('recognises facts down the rows and who knows them across', () => {
    const found = run({ 'reference/knowledge.md': TABLE })
      .filter((s) => s.destination.kind === 'knowledge');
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain('facts down the rows');
  });

  it('leaves a table that is not about knowledge alone', () => {
    const other = [
      '# Word counts', '', '| Scene | Words |', '|---|---|', '| One | 900 |',
    ].join('\n');
    expect(run({ 'reference/counts.md': other }).every((s) => s.destination.kind === 'skip'))
      .toBe(true);
  });
});

describe('what the rules refuse to guess at', () => {
  it('skips anything no rule recognised, and says so', () => {
    const [only] = run({ 'notes/thoughts.md': '# Thoughts\nSomething unstructured.\n' });
    expect(only?.destination.kind).toBe('skip');
    expect(only?.reason).toContain('no rule recognised');
  });

  it('still lists what it skipped, rather than quietly omitting it', () => {
    // The only way to find a missed section in a silent list is to notice its
    // absence, which nobody does across two hundred rows.
    const suggestions = run({ 'notes/a.md': '# A\nprose\n## B\nmore prose\n' });
    expect(suggestions.map((s) => s.label)).toEqual(['A', 'B']);
  });

  it('says nothing at all about an empty heading', () => {
    expect(run({ 'notes/a.md': '# Bare\n' })).toEqual([]);
  });

  it('offers prose in a scenes folder as a scene', () => {
    expect(shape(run({ 'scenes/scene-1.md': '# Arrival\nThe harbour was empty.\n' })))
      .toEqual(['Arrival:scene']);
  });
});

describe('matching what is already there', () => {
  const existing = new Map([
    [nameKey('Ilva'), { id: 'e1', name: 'Ilva', typeKey: 'character' }],
  ]);

  it('flags a heading that is already a name in the codex', () => {
    const [only] = run({ 'characters/ilva.md': '# Ilva\nUpdated dossier.\n' }, context(existing));
    expect(only?.matchesEntityId).toBe('e1');
  });

  it('lets an existing name override a folder that said nothing', () => {
    // A strong enough signal to act on where the path gives nothing at all.
    const [only] = run({ 'misc/scratch.md': '# Ilva\nMore about her.\n' }, context(existing));
    expect(only?.destination).toEqual({ kind: 'entity', typeKey: 'character' });
    expect(only?.reason).toContain('already in your codex');
  });

  it('matches regardless of case', () => {
    const [only] = run({ 'misc/x.md': '# ILVA\nShouting.\n' }, context(existing));
    expect(only?.matchesEntityId).toBe('e1');
  });
});

describe('fields onto columns', () => {
  it('puts a writer’s own vocabulary in attributes rather than dropping it', () => {
    // `Lie:` and `Beat path:` are theirs. Flattening them into the description
    // would lose the structure they were most deliberate about.
    expect(defaultFieldTarget('Beat path')).toEqual({ kind: 'attribute', key: 'beat path' });
  });

  it('recognises the few keys that are really columns', () => {
    expect(defaultFieldTarget('One line')).toEqual({ kind: 'column', column: 'summary' });
    expect(defaultFieldTarget('Status')).toEqual({ kind: 'column', column: 'status' });
  });
});

describe('rules and the plan', () => {
  const HOUSE = '# House Style\n\n## House\n\n- No em dashes.\n- Two spaces after a period.\n- Trust the reader.\n';
  const LAWS = '# Laws\n\nPower core in the chest.\n\nOnce out she cannot go home.\n';
  const OUTLINE = [
    '# Outline', '', '## Movement 1. The door', '',
    '#### 1. Night 0 — written', '', '1. He knocks.', '',
    '#### 2. Wren — not written', '', '1. Wren counts.', '',
  ].join('\n');

  it('offers a style file as style laws and a laws file as canon laws', () => {
    expect(shape(run({ 'reference/house-style.md': HOUSE }))).toEqual(['House Style:law']);
    const [law] = run({ 'reference/laws.md': LAWS });
    expect(law?.destination).toEqual({ kind: 'law', category: 'canon' });
    expect(law?.reason).toContain('2 of them');
    const [style] = run({ 'reference/house-style.md': HOUSE });
    expect(style?.destination).toEqual({ kind: 'law', category: 'style' });
    expect(style?.reason).toContain('one per bullet');
  });

  it('offers an outline as the plan, and claims its sections with it', () => {
    const out = run({ 'reference/outline.md': OUTLINE });
    expect(shape(out)).toEqual(['Outline:plan']);
  });

  it('does not read a file of prose sections as a plan, nor a scene as laws', () => {
    // Two H2s of prose and no numbered headings: a plan file in name only.
    expect(shape(run({ 'reference/plan.md': '# Plan\n\n## Time\n\nWeeks.\n\n## Money\n\nNinety.\n' })))
      .toEqual(['Time:skip', 'Money:skip']);
    // Prose under scenes/ that happens to mention the word "rules".
    expect(shape(run({ 'scenes/rules.md': '# The rules\n\nShe broke them.\n' }))).toEqual(['The rules:scene']);
  });

  it('never lets a laws file be mistaken for a list of characters', () => {
    expect(shape(run({ 'characters/laws.md': LAWS }))).toEqual(['Laws:entity/character']);
  });
});
