import { describe, it, expect } from 'vitest';
import {
  chunkDocument, estimateTokens, mergeExtracted, parseExtractReply, renderExtractPrompt,
  type Chunk, type ExtractTypes,
} from './extract';
import { parseMarkdown } from '../import/markdown';

/** Fixtures invented — D14. */

const types: ExtractTypes = {
  types: [{ key: 'character', label: 'Character' }, { key: 'location', label: 'Location' }],
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
  it('offers only the project types, names the known entities, and asks for one JSON object', () => {
    const p = renderExtractPrompt(chunk, types);
    expect(p).toContain('ENTITY TYPES YOU MAY USE: character (Character), location (Location)');
    expect(p).toContain('NAMES ALREADY IN THE CODEX (reuse them exactly when the text means the same person or thing): Renn');
    expect(p).toContain('SOURCE (cast/ilva.md)\n# Ilva'.replace('# Ilva', 'Ilva').slice(0, 20));
    expect(p).toContain('Answer with one JSON object and no other text:');
    expect(p).toContain('Do not invent names, facts or rules.');
  });
});

describe('parseExtractReply', () => {
  const reply = `Here you go:\n\`\`\`json\n${JSON.stringify({
    entities: [
      { name: 'Ilva', type: 'Character', aliases: ['the Warden', 'Ilva'], summary: 'Keeper of the seal.', quote: 'She keeps the seal, and the gate behind it.', confidence: 0.95 },
      { name: 'Renn', type: 'character', aliases: [], summary: 'Calls Ilva the Warden.', quote: 'Renn calls her the Warden', confidence: 0.8 },
      { name: 'The Seal', type: 'item', summary: 'A fake.', quote: 'The seal is a fake', confidence: 0.7 },
      { name: 'Maren', type: 'character', summary: 'Invented.', quote: 'Maren walked in from the rain', confidence: 0.9 },
    ],
    facts: [
      { subject: 'Ilva', statement: 'The seal Ilva keeps is a fake.', knownBy: [{ entity: 'Renn', belief: 'suspects', how: '' }, { entity: 'Ilva', belief: 'certain', how: '' }], quote: 'The seal is a fake, though only Renn suspects it.', confidence: 1.4 },
      { subject: '', statement: 'Ilva wants the throne.', knownBy: [], quote: 'Want: the throne.', confidence: 'high' },
    ],
    laws: [
      { category: 'style', title: '', rule: 'Never name the Warden in narration; only in speech.', quote: 'calls her the Warden', confidence: 0.3 },
      { category: 'voice', title: 'x', rule: 'Ilva speaks in fragments.', quote: 'x', confidence: 0.3 },
    ],
  })}\n\`\`\``;

  it('reads entities, aliases, facts, knowledge and laws into stageable proposals', () => {
    const r = parseExtractReply(reply, chunk, types);
    expect(r.malformed).toBe(false);
    const tables = r.proposals.map((p) => p.table);
    expect(tables).toEqual(['entity', 'entity_alias', 'entity', 'entity', 'fact', 'fact_knowledge', 'fact', 'law']);

    const [ilva, alias, renn, maren, fact, known, want, law] = r.proposals;
    expect(ilva).toMatchObject({
      op: 'new', payload: { name: 'Ilva', typeKey: 'character', summary: 'Keeper of the seal.' },
      confidence: 0.95, evidenceVerified: true, evidenceQuote: 'She keeps the seal, and the gate behind it.',
    });
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
    expect(want).toMatchObject({ payload: { subjectName: null }, confidence: 0.5 }); // 'high' is not a number

    expect(law).toMatchObject({
      table: 'law', payload: { category: 'style', severity: 'must', ruleText: 'Never name the Warden in narration; only in speech.', order: 0 },
      evidenceVerified: true,
    });
    expect((law!.payload as { title: string }).title).toBe('Never name the Warden in narration;…');
  });

  it('drops what the project cannot hold, and says why', () => {
    const r = parseExtractReply(reply, chunk, types);
    expect(r.dropped).toEqual([
      { what: 'The Seal', reason: 'the model called it a “item”, a type this project does not have' },
      { what: 'Ilva speaks in fragments.', reason: 'the model filed it under “voice”, not style, canon or content' },
    ]);
  });

  it('calls anything but one JSON object malformed', () => {
    expect(parseExtractReply('No entities here.', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('[{"name":"x"}]', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('{"entities": [', chunk, types).malformed).toBe(true);
    expect(parseExtractReply('{"entities": [], "facts": [], "laws": []}', chunk, types))
      .toEqual({ proposals: [], dropped: [], malformed: false });
    expect(parseExtractReply('{}', chunk, types).malformed).toBe(false);
  });
});

describe('mergeExtracted', () => {
  it('folds one entity per name across chunks, keeping the longer summary and any verified quote', () => {
    const a = parseExtractReply(JSON.stringify({ entities: [
      { name: 'Ilva', type: 'character', summary: 'Short.', quote: 'nowhere in the text at all', confidence: 0.4 },
      { name: 'ilva', type: 'character', aliases: ['the Warden'], summary: 'Keeper of the seal and the gate.', quote: 'She keeps the seal', confidence: 0.9 },
    ], facts: [
      { statement: 'Same fact.', quote: 'Want: the throne.' }, { statement: 'Same fact.', quote: 'Want: the throne.' },
    ] }), chunk, types);
    const merged = mergeExtracted(a.proposals);
    expect(merged.filter((p) => p.table === 'entity')).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      payload: { name: 'Ilva', summary: 'Keeper of the seal and the gate.' }, confidence: 0.9,
      evidenceVerified: true, evidenceQuote: 'She keeps the seal',
    });
    expect(merged.filter((p) => p.table === 'entity_alias')).toHaveLength(1);
    // Facts are not folded: two chunks saying one thing twice is for the reviewer to see.
    expect(merged.filter((p) => p.table === 'fact')).toHaveLength(2);
  });
});
