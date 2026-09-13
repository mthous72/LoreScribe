import { describe, it, expect } from 'vitest';
import { detectSpans, detectMentions, usableAliases, type AliasEntry } from './mentions';

const A = (entityId: string, alias: string, extra: Partial<AliasEntry> = {}): AliasEntry =>
  ({ entityId, alias, ...extra });

const KAELEN = [A('e1', 'Kaelen'), A('e1', 'the Grey Warden'), A('e1', 'Captain')];

describe('matching', () => {
  it('finds a name and reports where it is', () => {
    const spans = detectSpans('Kaelen crossed the yard.', KAELEN);
    expect(spans).toEqual([{ entityId: 'e1', alias: 'Kaelen', start: 0, end: 6 }]);
  });

  it('prefers the longest alias, not the first one that fits', () => {
    // JavaScript alternation takes the first branch that matches, so without
    // longest-first ordering every "the Grey Warden" would be filed as
    // "Warden" and the distinction the writer drew would disappear.
    const spans = detectSpans('They called him the Grey Warden.', [...KAELEN, A('e1', 'Warden')]);
    expect(spans.map((s) => s.alias)).toEqual(['the Grey Warden']);
  });

  it('matches case-insensitively but keeps the surface form used', () => {
    const spans = detectSpans('KAELEN shouted. kaelen did not.', KAELEN);
    expect(spans.map((s) => s.alias)).toEqual(['KAELEN', 'kaelen']);
  });

  it('matches a possessive but not a longer word', () => {
    expect(detectSpans("Kaelen's blade", KAELEN).map((s) => s.alias)).toEqual(['Kaelen']);
    expect(detectSpans('Kaelen’s blade', KAELEN)).toHaveLength(1);
    expect(detectSpans('Kaelenish customs', KAELEN)).toEqual([]);
    expect(detectSpans('unKaelen', KAELEN)).toEqual([]);
  });

  it('handles punctuation and line breaks around a name', () => {
    const text = '"Kaelen!" she said.\nKaelen, again—Kaelen.';
    expect(detectSpans(text, KAELEN)).toHaveLength(3);
  });

  it('honours auto_link being switched off for a too-generic alias', () => {
    const aliases = [A('e1', 'Kaelen'), A('e2', 'Captain', { autoLink: false })];
    const spans = detectSpans('The Captain nodded at Kaelen.', aliases);
    expect(spans.map((s) => s.entityId)).toEqual(['e1']);
  });

  it('refuses to guess when two entities share an alias', () => {
    // Linking one of them would be a claim the writer never made. Doc 08's
    // product rules require evidence for an assertion; a derived link is one.
    const aliases = [A('e1', 'the Captain'), A('e2', 'the Captain')];
    expect(detectSpans('The Captain nodded.', aliases)).toEqual([]);
  });

  it('returns nothing for empty text or no aliases', () => {
    expect(detectSpans('', KAELEN)).toEqual([]);
    expect(detectSpans('Some prose.', [])).toEqual([]);
  });

  it('treats regex metacharacters in an alias as literal text', () => {
    const aliases = [A('e9', 'Dr. O(1)')];
    expect(detectSpans('They called her Dr. O(1) for short.', aliases)).toHaveLength(1);
    expect(detectSpans('They called her DrXO 1  for short.', aliases)).toEqual([]);
  });

  it('matches names with accents and non-Latin scripts', () => {
    expect(detectSpans('Zoë waited.', [A('e1', 'Zoë')])).toHaveLength(1);
    expect(detectSpans('Then 花子 spoke.', [A('e2', '花子')])).toHaveLength(1);
  });
});

describe('the spoiler-aware alias rule', () => {
  const aliases = [A('e1', 'Kaelen'), A('e1', 'the Grey Warden', { linkableFromRank: 'a5' })];

  it('does not link an alias before the reader can connect it', () => {
    const spans = detectSpans('The Grey Warden rode past Kaelen.', aliases, { sceneRank: 'a2' });
    expect(spans.map((s) => s.alias)).toEqual(['Kaelen']);
  });

  it('links it once the manuscript has reached the reveal', () => {
    const spans = detectSpans('The Grey Warden rode past.', aliases, { sceneRank: 'a9' });
    expect(spans.map((s) => s.alias.toLowerCase())).toEqual(['the grey warden']);
  });

  it('links it when the scene position is unknown, rather than hiding it', () => {
    expect(usableAliases(aliases)).toHaveLength(2);
  });
});

describe('roles', () => {
  it('derives pov from the authored field, not from the prose', () => {
    const { mentions } = detectMentions('Kaelen woke.', KAELEN, { povEntityId: 'e1' });
    expect(mentions[0]).toMatchObject({ entityId: 'e1', role: 'pov' });
  });

  it('includes the POV character even when the scene never names them', () => {
    // Close third may never use the name. A brief that omitted the POV would
    // be worse than useless.
    const { mentions } = detectMentions('She woke before dawn.', KAELEN, { povEntityId: 'e1' });
    expect(mentions).toEqual([expect.objectContaining({ entityId: 'e1', role: 'pov', occurrences: 0 })]);
  });

  it('separates present from merely mentioned by frequency', () => {
    const aliases = [A('e1', 'Kaelen'), A('e2', 'Bren'), A('e3', 'Ilva')];
    const text = 'Kaelen spoke to Kaelen’s reflection. Bren waited. Bren sighed. Ilva was named once.';
    const { mentions } = detectMentions(text, aliases);
    const role = (id: string) => mentions.find((m) => m.entityId === id)!.role;
    expect(role('e1')).toBe('present');
    expect(role('e2')).toBe('present');
    expect(role('e3')).toBe('mentioned');
  });

  it('never invents focus — that is the writer’s judgement', () => {
    const { mentions } = detectMentions('Kaelen. Kaelen. Kaelen. Kaelen.', KAELEN);
    expect(mentions.every((m) => m.role !== 'focus')).toBe(true);
  });

  it('orders by role then frequency, so a brief can seed from the top', () => {
    const aliases = [A('e1', 'Kaelen'), A('e2', 'Bren'), A('e3', 'Ilva')];
    const { mentions } = detectMentions(
      'Ilva, Ilva, Ilva. Bren once. Kaelen watched.', aliases, { povEntityId: 'e1' });
    expect(mentions.map((m) => m.entityId)).toEqual(['e1', 'e3', 'e2']);
  });

  it('records the first occurrence and the count', () => {
    const { mentions } = detectMentions('Later, Kaelen. Then Kaelen again.', KAELEN);
    expect(mentions[0]).toMatchObject({
      entityId: 'e1', aliasUsed: 'Kaelen', startOffset: 7, endOffset: 13, occurrences: 2,
    });
  });
});

describe('scale', () => {
  it('scans a novel-sized scene against a full cast quickly', () => {
    // The detector runs on every save, so this is a real constraint rather
    // than a curiosity. 200 aliases over ~50k characters.
    const aliases = Array.from({ length: 200 }, (_, i) => A(`e${i}`, `Person${i}`));
    const sentence = 'Person7 crossed the yard while Person88 watched from the wall. ';
    const text = sentence.repeat(800);

    const t0 = performance.now();
    const { mentions } = detectMentions(text, aliases);
    const ms = performance.now() - t0;

    expect(mentions.map((m) => m.entityId).sort()).toEqual(['e7', 'e88']);
    expect(mentions[0]!.occurrences).toBe(800);
    expect(ms, `took ${ms.toFixed(0)}ms`).toBeLessThan(500);
  });
});
