import { describe, it, expect } from 'vitest';
import { compileBrief, estimateTokens, type BudgetInput, type TokenCounter } from './briefBudget';
import {
  attachFacts, expandOneHop, renderDossiers, seedBrief,
  type Dossiered, type EntityRow, type FactRow, type RelationshipRow,
} from './sceneBrief';
import type { Ladder } from './continuityLadder';
import type { BriefLaw, Laws, Severity } from './lawsAndBans';
import type { Supplement, SupplementHit } from './semanticSupplement';

/**
 * Step 9 turns structure into the text the model reads and fits it to a
 * window. Two things are tested: that the shape of every block is what doc 03
 * and doc 09 asked for, and that when the window is too small each section
 * shrinks *its own way* — a dossier drops a rung, the ladder loses its oldest
 * rung, the tail is re-cut — and nothing is ever sliced mid-string.
 *
 * Budgets are counted in whitespace words throughout, by a counter passed in,
 * so every number below can be checked by eye.
 */

const AT = 'a1a1a1';
const words: TokenCounter = (t) => t.split(/\s+/).filter(Boolean).length;
const say = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${from + i}`).join(' ');

const entity = (id: string, over: Partial<EntityRow> = {}): EntityRow => ({
  id, name: id, typeKey: 'character', importance: 'minor',
  summary: `${id} in one line.`, description: `${id} described at some length here.`, ...over,
});

const fact = (id: string, subject: string, over: Partial<FactRow> = {}): FactRow => ({
  id, subjectEntityId: subject, objectEntityId: null, predicate: 'is',
  statement: `${id} is so.`, certainty: 'canon', spoilerWeight: 0, isDramaticIrony: false,
  establishedRank: 'a0', revealedRank: 'a0', invalidatedRank: null, supersedesFactId: null,
  ...over,
});

/** Ilva (POV) and Renn (present) at the Kiln, one beat, Renn related to Ossa. */
function dossiered(over: {
  facts?: FactRow[]; relationships?: RelationshipRow[]; voice?: boolean; beats?: boolean;
} = {}): Dossiered {
  const world = new Map(['Ilva', 'Renn', 'the Kiln', 'Ossa'].map((id) => [id, entity(id)]));
  const seed = seedBrief({
    scene: {
      id: 'here', title: 'The gate', globalRank: AT, purpose: 'Get her through.', summary: null,
      povEntityId: 'Ilva', povMode: 'close_third', tense: 'past',
      locationEntityId: 'the Kiln', wordCount: 0,
    },
    mentions: [{ entityId: 'Renn', role: 'present' }],
    entities: world,
    beats: over.beats === false ? [] : [{
      beatId: 'b1', title: 'She is asked directly', summary: 'And does not answer.',
      function: 'turn', tension: 7, role: 'payoff',
      arcId: 'arc', arcName: 'The seal', arcKind: 'mystery',
    }],
  });
  const expanded = expandOneHop({
    seed, atRank: AT, entities: world,
    relationships: over.relationships ?? [{
      fromEntityId: 'Renn', toEntityId: 'Ossa', kind: 'family', label: 'brother of',
      strength: 2, isSecret: false, sinceRank: null, untilRank: null,
    }],
  });
  const briefed = attachFacts({
    expanded, atRank: AT,
    facts: over.facts ?? [fact('f-ilva', 'Ilva'), fact('f-renn', 'Renn')],
  });
  return renderDossiers({
    briefed, atRank: AT,
    voiceNotes: over.voice === false ? [] : [
      { entityId: 'Ilva', title: 'Clipped', ruleText: 'She does not explain herself.', severity: 'must' },
    ],
  });
}

/** `dossiered()` with extra relationships whose far ends exist. */
const dossieredWith = (relationships: RelationshipRow[]): Dossiered => {
  const extra = relationships.map((r) => r.toEntityId);
  const world = new Map(['Ilva', 'Renn', 'the Kiln', ...extra].map((id) => [id, entity(id)]));
  const base = dossiered({ relationships: [] });
  const expanded = expandOneHop({
    seed: { ...base, cast: base.cast, setting: base.setting },
    atRank: AT, entities: world, relationships,
  });
  const briefed = attachFacts({ expanded, atRank: AT, facts: [] });
  return renderDossiers({ briefed, atRank: AT });
};

const rung = (id: string, summary: string) => ({ id, title: id, summary });

const ladder = (over: Partial<Ladder> = {}): Ladder => ({
  tail: { sceneId: 'prev', title: 'prev', text: `${say(20)}\n\n${say(20, 21)} and she left.`, words: 43, truncated: false },
  scenes: [rung('s1', 'Scene one happened.'), rung('s2', 'Scene two happened.')],
  chapters: [rung('c1', 'Chapter one happened.')],
  parts: [rung('p1', 'Act one happened.')],
  missing: [],
  ...over,
});

const law = (id: string, severity: Severity, over: Partial<BriefLaw> = {}): BriefLaw => ({
  id, scopeType: 'project', category: 'style', severity,
  title: id, ruleText: `Rule ${id}.`, examplesGood: null, examplesBad: null, isSystem: false,
  ...over,
});

const laws = (over: Partial<Laws> = {}): Laws => ({
  laws: [law('L-must', 'must', { examplesGood: 'Like this.' }), law('L-should', 'should'), law('L-prefer', 'prefer')],
  canon: [{ factId: 'f-ilva', subjectEntityId: 'Ilva', ruleText: 'f-ilva is so.', severity: 'must' }],
  bans: { phrases: ['corrugated iron sang'], words: ['heavy'], openings: [] },
  ...over,
});

const hit = (id: string, text = `${id} text`): SupplementHit => ({
  ownerTable: 'note', ownerId: id, title: null, text, score: 1,
});

const supplement = (hits: SupplementHit[] = [hit('r1'), hit('r2')]): Supplement =>
  ({ query: 'q', hits });

const compile = (over: Partial<BudgetInput> = {}) => compileBrief({
  dossiered: dossiered(), ladder: ladder(), supplement: supplement(), laws: laws(),
  reference: [hit('ref', 'imported passage')], exemplars: ['An exemplar passage.'],
  window: 100_000, options: { count: words }, ...over,
});

const block = (text: string, name: string) => {
  const m = text.match(new RegExp(`=== ${name} ===\\n([\\s\\S]*?)\\n=== END ${name} ===\\n?([^\\n]*)`));
  return m ? { body: m[1]!, binding: m[2] ?? '' } : null;
};

describe('the shape of the text', () => {
  it('fences every block and restates the binding after the constraint blocks', () => {
    const { text } = compile();
    expect(block(text, 'LAWS')?.binding)
      .toBe('These rules are absolute. Every line you write must comply with them.');
    expect(block(text, 'BEATS')?.binding).toMatch(/must accomplish every beat/);
    expect(block(text, 'BANS')?.binding).toMatch(/bans are absolute/);
    expect(block(text, 'CAST AND SETTING')?.binding).toBe('');
  });

  it('opens on the scene and ends on the seam', () => {
    const { text } = compile();
    expect(text.startsWith('=== SCENE ===')).toBe(true);
    expect(text.trimEnd().endsWith('=== END STORY SO FAR ===')).toBe(true);
    expect(text).toMatch(/continue directly from here\):\n\n[\s\S]*and she left\.\n=== END STORY SO FAR ===/);
  });

  it('groups laws by severity, must first, with the examples that exist', () => {
    const body = block(compile().text, 'LAWS')?.body ?? '';
    expect(body.indexOf('MUST:')).toBeLessThan(body.indexOf('SHOULD:'));
    expect(body.indexOf('SHOULD:')).toBeLessThan(body.indexOf('PREFER:'));
    expect(body).toContain('- [L-must] Rule L-must.\n  Good: Like this.');
  });

  it('emits nothing for a section with nothing in it', () => {
    const { text, sections } = compile({
      supplement: supplement([]), reference: [], exemplars: [],
      dossiered: dossiered({ beats: false }),
      laws: laws({ canon: [], bans: { phrases: [], words: [], openings: [] } }),
    });
    for (const name of ['RELATED', 'REFERENCE', 'STYLE', 'BEATS', 'CANON', 'BANS']) {
      expect(text).not.toContain(`=== ${name} ===`);
    }
    expect(sections.find((s) => s.key === 'related')?.tokens).toBe(0);
  });

  it('labels the reference band as background, never canon', () => {
    expect(block(compile().text, 'REFERENCE')?.body).toMatch(/not canon and must not be reproduced/);
  });
});

describe('what a fact line says', () => {
  const only = (f: FactRow) => block(compile({
    dossiered: dossiered({ facts: [f] }), laws: laws({ canon: [] }),
  }).text, 'FACTS')?.body ?? '';

  it('names the point of view on a fact only they know', () => {
    expect(only(fact('k', 'Renn', {
      revealedRank: null,
      knowledge: [{ entityId: 'Ilva', belief: 'knows', knownFromRank: 'a0' }],
    }))).toContain('- k is so. (known to Ilva, not yet to the reader)');
  });

  it('calls a suspicion a suspicion, not knowledge', () => {
    expect(only(fact('s', 'Renn', {
      revealedRank: null,
      knowledge: [{ entityId: 'Ilva', belief: 'suspects', knownFromRank: 'a0' }],
    }))).toContain('- s is so. (Ilva suspects this; the reader has not been told)');
  });

  it('marks dramatic irony, an unsettled fact, and a wrong belief', () => {
    expect(only(fact('i', 'Renn', { revealedRank: null, isDramaticIrony: true })))
      .toContain('(the reader knows; the characters do not)');
    expect(only(fact('s', 'Renn', { certainty: 'speculative' })))
      .toContain('(speculative — not yet settled)');
    expect(only(fact('w', 'Renn', {
      knowledge: [{ entityId: 'Ilva', belief: 'believes_false', knownFromRank: null }],
    }))).toContain('(Ilva believes this is false)');
  });

  it('groups facts under the entity they are about', () => {
    const body = block(compile().text, 'FACTS')?.body ?? '';
    expect(body).toBe('Ilva:\n- f-ilva is so.\nRenn:\n- f-renn is so.');
  });
});

describe('canon', () => {
  it('is one binding over FACTS, not a second copy of each fact', () => {
    const { text } = compile();
    expect(block(text, 'CANON')?.body).toMatch(/Everything in FACTS is canon/);
    expect(text.split('f-ilva is so.').length - 1).toBe(1);
    expect(text.indexOf('=== CANON ===')).toBeLessThan(text.indexOf('=== FACTS ==='));
  });
});

describe('what is never trimmed', () => {
  it('keeps the fixed blocks whole in a window that fits nothing else', () => {
    const out = compile({ window: 130 });
    for (const name of ['SCENE', 'BEATS', 'LAWS', 'DO NOT REVEAL', 'BANS']) {
      if (name === 'DO NOT REVEAL') continue; // fixture has no negatives
      expect(out.text).toContain(`=== ${name} ===`);
    }
    for (const key of ['scene', 'beats', 'laws', 'bans', 'canon', 'negative'] as const) {
      expect(out.sections.find((s) => s.key === key)?.allowed).toBeNull();
    }
  });

  it('gives up prefer laws, then should, before admitting overflow', () => {
    const fixedOnly = compile({ window: 100_000 }).sections
      .filter((s) => s.allowed === null).reduce((n, s) => n + s.tokens, 0);
    const squeezed = compile({ window: Math.round(fixedOnly / 0.9) - 4 });
    const lawsBlock = squeezed.sections.find((s) => s.key === 'laws')!;
    expect(lawsBlock.trimmed).toEqual(['dropped 1 prefer law to fit']);
    expect(lawsBlock.text).not.toContain('L-prefer');
    expect(lawsBlock.text).toContain('L-should');
    expect(squeezed.overflow).toBe(false);
  });

  it('never drops a must law, and says so when it still does not fit', () => {
    const out = compile({ window: 40 });
    expect(out.overflow).toBe(true);
    expect(out.text).toContain('[L-must]');
    expect(out.sections.find((s) => s.key === 'laws')?.trimmed)
      .toEqual(['dropped 1 prefer law to fit', 'dropped 1 should law to fit']);
  });
});

/**
 * The largest window at which `key` has had to give something up and still
 * has something left. Found from the report rather than computed, because the
 * point of these tests is *how* a section shrinks, not the share arithmetic —
 * which has its own test below.
 */
const squeeze = (
  key: string,
  over: Partial<BudgetInput> = {},
  until: (s: { trimmed: string[]; text: string }) => boolean = (s) => s.trimmed.length > 0,
) => {
  for (let window = 1500; window > 40; window -= 5) {
    const out = compile({ ...over, window });
    const s = out.sections.find((x) => x.key === key)!;
    if (until(s) && s.text !== '') return out;
  }
  throw new Error(`no window squeezes ${key}`);
};

const sectionOf = (out: ReturnType<typeof compile>, key: string) =>
  out.sections.find((s) => s.key === key)!;

describe('how a section shrinks', () => {
  it('thins the thinnest entries first, and the one furthest down among equals', () => {
    // Ossa is a name-only neighbour who is not in the room; the Kiln is where
    // the room is. The brother goes first.
    const cast = sectionOf(squeeze('cast'), 'cast');
    expect(cast.trimmed[0]).toBe('Ossa: name-only → dropped');
    expect(cast.text).toContain('## Ilva');
    expect(cast.tokens).toBeLessThanOrEqual(cast.allowed!);
  });

  it('thins the thinnest entry all the way down before starting on the next', () => {
    // A window the fixed blocks alone overflow, so the cast is allowed nothing
    // and every dossier is degraded to nothing: the order that happened in is
    // the priority order. The setting goes before Renn because it is last among
    // equals; once it is a name-only line it is the thinnest thing there is.
    const out = compile({ window: 40, dossiered: dossiered({ relationships: [] }) });
    expect(sectionOf(out, 'cast').trimmed).toEqual([
      'the Kiln: standard → name-only',
      'the Kiln: name-only → dropped',
      'Renn: standard → name-only',
      'Renn: name-only → dropped',
      'Ilva: full → standard',
      'Ilva: standard → name-only',
      'Ilva: name-only → dropped',
    ]);
  });

  it('takes the voice notes with the rung when a full entry is knocked to standard', () => {
    // Step 5 gives voice notes to full entries only; this is where a full entry
    // stops being one, and the notes have to go with the rung or the budget
    // has cut the description and kept the more expensive thing.
    const out = squeeze('cast', { dossiered: dossiered({ relationships: [] }) },
      (s) => s.trimmed.includes('Ilva: full → standard') && !s.trimmed.includes('Ilva: standard → name-only'));
    const cast = sectionOf(out, 'cast');
    expect(cast.text).toContain('Ilva described at some length here.');
    expect(cast.text).not.toContain('Voice:');
    expect(cast.text).not.toContain('She does not explain herself.');
  });

  it('never slices a dossier', () => {
    for (let window = 400; window > 100; window -= 20) {
      const cast = sectionOf(compile({ window }), 'cast');
      if (!cast.text) continue;
      for (const l of cast.text.split('\n')) {
        expect(l.startsWith('## ') || l.startsWith('=== ') || l === '' || /[.:)]$|^Voice:$|^[-A-Za-z]/.test(l)).toBe(true);
      }
    }
  });

  it('drops facts from the tail of step 3’s order', () => {
    const facts = sectionOf(squeeze('facts'), 'facts');
    expect(facts.trimmed).toEqual(['dropped fact: f-renn is so.']);
    expect(facts.text).toContain('f-ilva is so.');
  });

  it('loses the ladder oldest rung first, still ending on the last words', () => {
    const cont = sectionOf(squeeze('continuity'), 'continuity');
    expect(cont.trimmed[0]).toBe('dropped act: p1');
    expect(cont.text).toMatch(/and she left\.\n=== END STORY SO FAR ===$/);
  });

  it('goes act, chapter, scene, then the tail', () => {
    // The fixture's tail is 43 words, already under the floor a re-cut would
    // stop at, so it goes whole rather than being re-cut to nothing.
    const out = compile({ window: 40 });
    expect(sectionOf(out, 'continuity').trimmed).toEqual([
      'dropped act: p1', 'dropped chapter: c1',
      'dropped scene summary: s1', 'dropped scene summary: s2',
      'dropped the tail',
    ]);
  });

  it('re-cuts the tail at a paragraph rather than truncating it', () => {
    // Three paragraphs of forty; long enough that the first cut is a re-cut and
    // not a drop. The re-cut is three quarters, and proseTail then keeps whole
    // paragraphs from the end — so the first paragraph goes and the last two
    // stay, still ending on the last words.
    const long = ladder({
      scenes: [], chapters: [], parts: [],
      tail: {
        sceneId: 'prev', title: 'prev', words: 123, truncated: false,
        text: `${say(40)}\n\n${say(40, 41)}\n\n${say(40, 81)} and she left.`,
      },
    });
    const cont = sectionOf(squeeze('continuity', { ladder: long }), 'continuity');
    expect(cont.trimmed[0]).toBe('tail re-cut to ~92 words');
    const body = block(cont.text, 'STORY SO FAR')?.body ?? '';
    // Starts exactly on the paragraph boundary — a word-slice of the same
    // budget would start mid-way through the first paragraph instead.
    expect(body).toContain(`continue directly from here):\n\n${say(40, 41)}\n\n${say(40, 81)} and she left.`);
    expect(body).not.toMatch(/\bw(?:[1-9]|[1-3]\d|40)\b/);
    expect(body.endsWith('and she left.')).toBe(true);
  });
});

describe('the reference band is reserved first', () => {
  it('gets the same room whether the cast is small or enormous', () => {
    const crowd: RelationshipRow[] = Array.from({ length: 12 }, (_, i) => ({
      fromEntityId: 'Renn', toEntityId: `Sib${i}`, kind: 'family', label: 'sibling of',
      strength: 1, isSecret: false, sinceRank: null, untilRank: null,
    }));
    const window = 600;
    const small = compile({ window, reference: [hit('ref', say(8))] });
    const large = compile({ window, reference: [hit('ref', say(8))], dossiered: dossieredWith(crowd) });
    expect(sectionOf(large, 'cast').trimmed.length).toBeGreaterThan(0);
    expect(sectionOf(large, 'reference').allowed).toBe(sectionOf(small, 'reference').allowed);
    expect(sectionOf(large, 'reference').text).toContain('w8');
    expect(sectionOf(large, 'reference').allowed).toBe(Math.round(window * 0.08));
  });
});

describe('the share arithmetic', () => {
  it('splits the pool by the table, normalised over the canon sections', () => {
    const out = compile({ window: 10_000, reference: [], options: { count: words, outputReserve: 1000 } });
    const fixed = out.sections.filter((s) => s.allowed === null).reduce((n, s) => n + s.tokens, 0);
    const pool = 9000 - fixed;
    expect(sectionOf(out, 'cast').allowed).toBe(Math.floor((pool * 0.25) / 0.82));
    expect(sectionOf(out, 'facts').allowed).toBe(Math.floor((pool * 0.18) / 0.82));
    expect(sectionOf(out, 'continuity').allowed).toBe(Math.floor((pool * 0.24) / 0.82));
    expect(sectionOf(out, 'style').allowed).toBe(Math.floor((pool * 0.08) / 0.82));
    expect(sectionOf(out, 'related').allowed).toBe(Math.floor((pool * 0.07) / 0.82));
  });

  it('takes what the reference band used off the canon pool, and only that', () => {
    const out = compile({
      window: 10_000, reference: [hit('ref', say(30))], options: { count: words, outputReserve: 1000 },
    });
    const fixed = out.sections.filter((s) => s.allowed === null).reduce((n, s) => n + s.tokens, 0);
    const refUsed = sectionOf(out, 'reference').tokens;
    expect(refUsed).toBeGreaterThan(0);
    const pool = 9000 - fixed - refUsed;
    expect(sectionOf(out, 'cast').allowed).toBe(Math.floor((pool * 0.25) / 0.82));
  });

  it('lets an over-full section use what an empty one did not, once', () => {
    const empty: Ladder = { tail: null, scenes: [], chapters: [], parts: [], missing: [] };
    // The largest window at which the cast is squeezed with the ladder present…
    const squeezed = squeeze('cast');
    // …is a window at which, with the ladder empty, it is not.
    const relieved = compile({ window: squeezed.window, ladder: empty });
    expect(sectionOf(relieved, 'cast').trimmed).toEqual([]);
    expect(sectionOf(relieved, 'cast').allowed).toBeGreaterThan(sectionOf(squeezed, 'cast').allowed!);
  });
});

describe('the report', () => {
  it('adds up, and takes a real counter when one is offered', () => {
    const out = compile();
    expect(out.used).toBe(out.sections.reduce((n, s) => n + s.tokens, 0));
    expect(out.outputReserve).toBe(10_000);
    const est = compileBrief({
      dossiered: dossiered(), ladder: ladder(), supplement: supplement(),
      laws: laws(), reference: [], exemplars: [], window: 100_000,
    });
    expect(est.sections[0]!.tokens).toBe(estimateTokens(est.sections[0]!.text));
  });

  it('estimates long rather than short', () => {
    expect(estimateTokens('a b c d')).toBeGreaterThanOrEqual(4);
    expect(estimateTokens(say(300))).toBeGreaterThanOrEqual(400);
  });
});
