import { describe, it, expect } from 'vitest';
import {
  chunkDocument, estimateTokens, mergeExtracted, mergeRecommendations, parseExtractReply, readAttributes,
  renderExtractPrompt, sectionsFor, slugType, type Chunk, type ExtractTypes, type Recommendation,
} from './extract';
import { parseMarkdown } from '../import/markdown';

/** Fixtures invented — D14. */

const types: ExtractTypes = {
  types: [
    { key: 'character', label: 'Character', attributes: ['age', 'occupation', 'want', 'lie'] },
    { key: 'location', label: 'Location' },
  ],
  existing: new Map([['renn', { id: 'e-renn', name: 'Renn', typeKey: 'character' }]]),
};

const doc = parseMarkdown('cast/ilva.md', [
  '# Ilva', 'She keeps the seal, and the gate behind it. Renn calls her the Warden.', '',
  '## Arc', 'Want: the throne.', '',
  '## Notes', 'The seal is a fake, though only Renn suspects it.', '',
].join('\n'));
const chunk: Chunk = chunkDocument(doc)[0]!;

describe('chunkDocument', () => {
  it('keeps a small file as one chunk, labelled by its path', () => {
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.label).toBe('cast/ilva.md');
    expect(chunks[0]!.text).toContain('Want: the throne.');
    expect(chunks[0]!.text).toContain('only Renn suspects it');
  });

  it('splits a big file at its sections, packs small neighbours, and cuts an over-long section at paragraphs', () => {
    const para = (w: string) => Array.from({ length: 30 }, () => w).join(' ');
    const big = parseMarkdown('bible.md', [
      '# Bible', '',
      '## A', para('alpha'), '', para('alpha'), '',
      '## B', para('beta'), '',
      '## C', para('gamma'), '', para('gamma'), '', para('gamma'), '',
    ].join('\n'));
    const chunks = chunkDocument(big, 70);
    // A (60) alone; B (30) packs with nothing before it fits? A+B = 90 > 70, so B starts a chunk;
    // C is 90 words on its own and is cut at a paragraph break.
    expect(chunks.map((c) => c.words)).toEqual([60, 30, 60, 30]);
    expect(chunks[0]!.label).toBe('bible.md › Bible › A');
    expect(chunks[2]!.label).toBe('bible.md › Bible › C');
    expect(chunks.every((c) => c.words <= 70)).toBe(true);
    expect(estimateTokens(chunks)).toBeGreaterThan(chunks.length * 350);
  });
});

describe('renderExtractPrompt', () => {
  it('splits into a fixed system turn and a per-source user turn, with the source fenced', () => {
    const p = renderExtractPrompt(chunk, types);
    // System: role, the quote rule with its reason, the example, the shape. The same for every call.
    expect(p.system).toContain('WRITE the entries');
    expect(p.system).toContain('resolve pronouns to names');
    expect(p.system).toContain('The quote is how the writer checks you.');
    expect(p.system).toContain('EXAMPLE — an invented source produced this answer:');
    expect(p.system).toContain('"name": "Tamsin Reel"');
    expect(p.system).toContain('keep it brief; the answer is the JSON');
    expect(p.system).not.toContain('<one');
    expect(p.system).not.toContain('confidence');
    expect(p.system).toBe(renderExtractPrompt({ ...chunk, text: 'other', label: 'x' }, types).system);
    // User: this project's types and names, and the fenced source.
    expect(p.user).toContain('character (Character; fields: age, occupation, want, lie)');
    expect(p.user).toContain('location (Location)');
    expect(p.user).toContain('NAMES ALREADY IN THE CODEX (reuse them exactly when the source means the same person or thing): Renn');
    expect(p.user).toContain('===== SOURCE: cast/ilva.md =====\nIlva');
    expect(p.user).toContain('===== END OF SOURCE =====');
    expect(p.user).toContain('SECTIONS WANTED FOR THIS SOURCE: entities, facts, relationships, laws, unplaced.');
  });

  it('asks for the sections a file can yield, and shows only those in the example', () => {
    expect(sectionsFor('Kiln-Row/notes/house-style.md')).toEqual(['laws', 'unplaced']);
    expect(sectionsFor('reference/who-knows-what.md')).toEqual(['entities', 'facts', 'relationships', 'unplaced']);
    expect(sectionsFor('characters/ilva.md')).toEqual(['entities', 'facts', 'relationships', 'laws', 'unplaced']);
    const rules = renderExtractPrompt(chunk, types, ['laws', 'unplaced']);
    expect(rules.system).toContain('- "laws":');
    expect(rules.system).not.toContain('- "entities":');
    expect(rules.system).not.toContain('Tamsin Reel');
    expect(rules.system).toContain('No weather openings');
    expect(rules.user).toContain('SECTIONS WANTED FOR THIS SOURCE: laws, unplaced.');
  });
});

describe('parseExtractReply', () => {
  const reply = `Here you go:\n\`\`\`json\n${JSON.stringify({
    entities: [
      {
        name: 'Ilva', type: 'Character', aliases: ['the Warden', 'Ilva'], summary: 'Keeper of the seal.',
        description: 'Ilva keeps the seal and the gate behind it. Renn calls her the Warden.\n\nShe wants the throne.',
        attributes: { Want: 'the throne', 'Known as': 'the Warden', age: 34, empty: '', nested: { a: 1 }, tags: ['a', 'b'] },
        quote: 'She keeps the seal, and the gate behind it.', confidence: 0.95,
      },
      { name: 'Renn', type: 'character', aliases: [], summary: 'Calls Ilva the Warden.', quote: 'Renn calls her the Warden', confidence: 0.8 },
      { name: 'The Seal', type: 'Magic Item', summary: 'A fake.', aliases: ['the false seal'], quote: 'The seal is a fake', confidence: 0.7 },
      { name: 'Maren', type: 'character', summary: 'Invented.', quote: 'Maren walked in from the rain', confidence: 0.9 },
    ],
    facts: [
      { subject: 'Ilva', statement: 'The seal Ilva keeps is a fake.', knownBy: [{ entity: 'Renn', belief: 'suspects', how: '' }, { entity: 'Ilva', belief: 'certain', how: '' }], quote: 'The seal is a fake, though only Renn suspects it.', confidence: 1.4 },
      { subject: '', statement: 'Ilva wants the throne.', knownBy: [], quote: 'Want: the throne.', confidence: 'high' },
    ],
    relationships: [
      { from: 'Renn', to: 'Ilva', kind: 'Serves', note: 'He counts for her.', quote: 'Renn calls her the Warden', confidence: 0.6 },
      { from: 'Ilva', to: 'Ilva', kind: 'self' },
      { from: 'Renn', kind: 'owes' },
    ],
    laws: [
      { category: 'style', title: '', rule: 'Never name the Warden in narration; only in speech.', quote: 'calls her the Warden', confidence: 0.3 },
      { category: 'voice', title: 'x', rule: 'Ilva speaks in fragments.', quote: 'x', confidence: 0.3 },
      { category: 'theme', title: 'x', rule: 'Everything is about debt.', quote: 'x' },
    ],
    unplaced: [
      { what: 'The Warden\'s oath', why: 'A ritual text, verse; belongs with the world\'s religion.', quote: 'gate behind it', confidence: 0.5 },
      { what: '', why: 'nothing' },
    ],
  })}\n\`\`\``;

  it('reads entities, aliases, relationships, facts, knowledge and laws into stageable proposals', () => {
    const r = parseExtractReply(reply, chunk, types);
    expect(r.malformed).toBe(false);
    const tables = r.proposals.map((p) => p.table);
    expect(tables).toEqual([
      'entity', 'entity_alias', 'entity', 'entity', 'relationship', 'fact', 'fact_knowledge', 'fact', 'law', 'law',
    ]);

    const [ilva, alias, renn, maren, serves, fact, known, want, law, voice] = r.proposals;
    expect(serves).toMatchObject({
      table: 'relationship', payload: { fromName: 'Renn', toName: 'Ilva', kind: 'serves', notes: 'He counts for her.' },
      evidenceVerified: true, confidence: 0.6,
    });
    expect(serves!.rationale).toBe('from cast/ilva.md — Renn serves Ilva');
    // Every category the laws engine has is accepted, not only the three the pull-down offers.
    expect(voice).toMatchObject({ table: 'law', payload: { category: 'voice' }, evidenceVerified: false });
    expect(ilva).toMatchObject({
      op: 'new',
      payload: {
        name: 'Ilva', typeKey: 'character', summary: 'Keeper of the seal.',
        description: 'Ilva keeps the seal and the gate behind it. Renn calls her the Warden.\n\nShe wants the throne.',
        attributes: { want: 'the throne', known_as: 'the Warden', age: '34', tags: 'a, b' },
      },
      confidence: 0.95, evidenceVerified: true, evidenceQuote: 'She keeps the seal, and the gate behind it.',
    });
    // Renn came with no description or attributes: nulls and an empty object, never invented.
    expect(renn!.payload).toMatchObject({ description: null, attributes: {} });
    expect(ilva!.rationale).toBe('from cast/ilva.md — the model read it as a character');
    // The alias that repeats the name is dropped; the other is a proposal of its own.
    expect(alias).toMatchObject({ table: 'entity_alias', payload: { entityName: 'Ilva', alias: 'the Warden' } });
    // Renn is already in the codex: an update, keeping the codex's own type.
    expect(renn).toMatchObject({ op: 'update', payload: { name: 'Renn', typeKey: 'character' } });
    expect(renn!.rationale).toContain('already in your codex');
    // Maren's quote is not in the file: staged, but unverified.
    expect(maren).toMatchObject({ payload: { name: 'Maren' }, evidenceVerified: false, evidenceQuote: 'Maren walked in from the rain' });

    expect(fact).toMatchObject({
      table: 'fact', payload: { statement: 'The seal Ilva keeps is a fake.', subjectName: 'Ilva' }, confidence: 1, evidenceVerified: true,
    });
    // One knowledge row: "certain" is not a belief the schema has.
    expect(known).toMatchObject({ table: 'fact_knowledge', payload: { entityName: 'Renn', belief: 'suspects', learnedHow: null } });
    expect((known!.payload as { factKey: string }).factKey).toBe((fact!.payload as { key: string }).key);
    // 'high' is not a number: confidence comes from the evidence instead, and this quote is in the file.
    expect(want).toMatchObject({ payload: { subjectName: null }, confidence: 0.9 });

    expect(law).toMatchObject({
      table: 'law', payload: { category: 'style', severity: 'must', ruleText: 'Never name the Warden in narration; only in speech.', order: 0 },
      evidenceVerified: true,
    });
    expect((law!.payload as { title: string }).title).toBe('Never name the Warden in narration;…');
  });

  it('recommends rather than drops: a new type with its entries held, and material with no home', () => {
    const r = parseExtractReply(reply, chunk, types);
    // Ilva's extra attributes recommend fields first; the order is the order things were read.
    expect(r.recommendations.map((x) => x.kind)).toEqual(['new_field', 'new_field', 'new_type', 'unplaced']);
    expect(r.recommendations.slice(0, 2)).toEqual([
      { kind: 'new_field', typeKey: 'character', field: 'known_as', names: ['Ilva'] },
      { kind: 'new_field', typeKey: 'character', field: 'tags', names: ['Ilva'] },
    ]);
    const newType = r.recommendations[2];
    const unplaced = r.recommendations[3];
    expect(newType).toMatchObject({
      kind: 'new_type', typeKey: 'magic_item', label: 'Magic Item', names: ['The Seal'],
    });
    expect((newType as { why: string }).why).toContain('a type this project does not have');
    type Held = { table: string; payload: { typeKey?: string; alias?: string } }[];
    const held = (newType as { held: Held }).held;
    expect(held.map((h) => [h.table, h.payload.typeKey ?? h.payload.alias]))
      .toEqual([['entity', 'magic_item'], ['entity_alias', 'the false seal']]);
    // Not staged: it waits on the writer.
    expect(r.proposals.some((p) => (p.payload as { name?: string }).name === 'The Seal')).toBe(false);

    expect(unplaced).toMatchObject({
      kind: 'unplaced', what: 'The Warden\'s oath', evidenceVerified: true, evidenceQuote: 'gate behind it',
      confidence: 0.5, label: 'cast/ilva.md',
    });
    // Only the truly unusable is dropped, with the reason.
    expect(r.dropped).toEqual([
      { what: 'a relationship missing an end or a kind', reason: 'incomplete' },
      { what: 'Everything is about debt.', reason: 'the model filed it under “theme”, not a category the laws engine has' },
    ]);
  });

  it('recommends a field when the model fills an attribute the type has no box for', () => {
    const r = parseExtractReply(JSON.stringify({ entities: [
      { name: 'Ilva', type: 'character', attributes: { want: 'the throne', Faction: 'the gate-wardens' }, quote: 'She keeps the seal' },
      { name: 'Renn', type: 'character', attributes: { faction: 'the counting house' }, quote: 'Renn calls her the Warden' },
    ] }), chunk, types);
    expect(r.recommendations).toEqual([{ kind: 'new_field', typeKey: 'character', field: 'faction', names: ['Ilva', 'Renn'] }]);
    // A type with no declared fields recommends nothing: there is no editor list to be missing from.
    const loc = parseExtractReply(JSON.stringify({ entities: [
      { name: 'The Gate', type: 'location', attributes: { climate: 'wet' }, quote: 'the gate behind it' },
    ] }), chunk, types);
    expect(loc.recommendations).toEqual([]);
  });

  it('matches a type by its slug, so "Magic Item" lands on an existing magic_item type', () => {
    const withItem: ExtractTypes = { ...types, types: [...types.types, { key: 'magic_item', label: 'Magic item' }] };
    const r = parseExtractReply(JSON.stringify({ entities: [
      { name: 'The Seal', type: 'Magic Item', quote: 'The seal is a fake' },
    ] }), chunk, withItem);
    expect(r.recommendations).toEqual([]);
    expect(r.proposals[0]!.payload).toMatchObject({ typeKey: 'magic_item' });
    expect(slugType('  Magic  Item! ')).toBe('magic_item');
  });

  it('calls anything but one JSON object malformed', () => {
    expect(parseExtractReply('No entities here.', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('[{"name":"x"}]', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('{"entities": [', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('{"entities": [], "facts": [], "laws": []}', chunk, types))
      .toEqual({ proposals: [], recommendations: [], dropped: [], malformed: false });
    expect(parseExtractReply('{}', chunk, types).malformed).toBe(false);
  });
});

describe('readAttributes', () => {
  it('normalises keys, stringifies scalars and lists, drops empties and nests', () => {
    expect(readAttributes({ ' Voice profile ': 'clipped', Age: 34, alive: true, none: '', deep: { x: 1 }, list: [1, 'b'] }))
      .toEqual({ voice_profile: 'clipped', age: '34', alive: 'true', list: '1, b' });
    expect(readAttributes(null)).toEqual({});
    expect(readAttributes(['a'])).toEqual({});
    expect(readAttributes({ long: 'x'.repeat(500) }).long).toHaveLength(400);
  });
});

describe('mergeExtracted', () => {
  it('folds one entity per name across chunks, keeping the longer summary and description, every attribute, and any verified quote', () => {
    const a = parseExtractReply(JSON.stringify({ entities: [
      { name: 'Ilva', type: 'character', summary: 'Short.', description: 'A long description of Ilva from chunk one.', attributes: { want: 'the throne' }, quote: 'nowhere in the text at all', confidence: 0.4 },
      { name: 'ilva', type: 'character', aliases: ['the Warden'], summary: 'Keeper of the seal and the gate.', description: 'Short.', attributes: { lie: 'I am owed it' }, quote: 'She keeps the seal', confidence: 0.9 },
    ], facts: [
      { statement: 'Same fact.', quote: 'Want: the throne.' }, { statement: 'Same fact.', quote: 'Want: the throne.' },
    ] }), chunk, types);
    const merged = mergeExtracted(a.proposals);
    expect(merged.filter((p) => p.table === 'entity')).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      payload: {
        name: 'Ilva', summary: 'Keeper of the seal and the gate.',
        description: 'A long description of Ilva from chunk one.', attributes: { want: 'the throne', lie: 'I am owed it' },
      },
      confidence: 0.9, evidenceVerified: true, evidenceQuote: 'She keeps the seal',
    });
    expect(merged.filter((p) => p.table === 'entity_alias')).toHaveLength(1);
    // Facts are not folded: two chunks saying one thing twice is for the reviewer to see.
    expect(merged.filter((p) => p.table === 'fact')).toHaveLength(2);
  });
});

describe('mergeRecommendations', () => {
  it('folds one recommendation per new type and per new field, keeps every unplaced item, and folds held entries', () => {
    const held = (name: string, quote: string) => parseExtractReply(JSON.stringify({ entities: [
      { name, type: 'Magic Item', summary: 's', quote },
    ] }), chunk, types).recommendations[0] as Recommendation;
    const merged = mergeRecommendations([
      held('The Seal', 'The seal is a fake'),
      { kind: 'new_field', typeKey: 'character', field: 'faction', names: ['Ilva'] },
      held('The Seal', 'She keeps the seal'),
      held('The Gate Key', 'the gate behind it'),
      { kind: 'unplaced', what: 'a', why: 'b', evidenceQuote: null, evidenceVerified: false, confidence: 0.5, label: 'x' },
      { kind: 'new_field', typeKey: 'character', field: 'faction', names: ['Renn', 'Ilva'] },
      { kind: 'unplaced', what: 'a', why: 'b', evidenceQuote: null, evidenceVerified: false, confidence: 0.5, label: 'y' },
    ]);
    expect(merged.map((r) => r.kind)).toEqual(['new_type', 'new_field', 'unplaced', 'unplaced']);
    const type = merged[0] as Extract<Recommendation, { kind: 'new_type' }>;
    expect(type.names).toEqual(['The Seal', 'The Gate Key']);
    expect(type.held.filter((h) => h.table === 'entity').map((h) => h.payload.name)).toEqual(['The Seal', 'The Gate Key']);
    expect((merged[1] as { names: string[] }).names).toEqual(['Ilva', 'Renn']);
  });
});
