import { describe, it, expect, beforeAll } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { BriefRepository, type SceneBriefResult } from './briefRepository';
import { buildFixture, type Fixture } from '../fixture/novel';

/**
 * The compiler, end to end, against the instrument built for it.
 *
 * Doc 08's Phase 2 bar is a comparison: a scene drafted at chapter 30 respects
 * a chapter-2 fact and does not leak a chapter-40 reveal. The fixture plants
 * one fact per branch of the spoiler rule and `novel.test.ts` proves each
 * branch fires; this file proves the *brief* — the text a model will actually
 * read — puts each of them where it belongs, and nowhere else.
 *
 * The assertions are unconditional on purpose. Whether a given character is in
 * the working set at chapter 30 depends on the seeded prose, and the domain
 * rule says a fact about somebody outside it is legitimately absent — so the
 * tests do not ask "is the fact there" but "if this statement appears anywhere
 * in the brief, is it in the one block it is allowed in". A leak is a leak
 * whatever the cast happens to be.
 */

let fixture: Fixture;
let at30: SceneBriefResult;
let at2: SceneBriefResult;

beforeAll(async () => {
  const driver = await NodeSqlDriver.open();
  fixture = await buildFixture(driver);
  const repo = new BriefRepository(driver);
  at30 = (await repo.compile(fixture.anchors.targetSceneId, { window: 32_000 }))!;
  at2 = (await repo.compile(fixture.scenesByChapter[1]![0]!, { window: 32_000 }))!;
});

const STATEMENTS = {
  early: 'Ilva keeps the ledger for the harbour master',
  lateReveal: 'Renn is the one who moved the seal',
  povSecret: 'Masha has been paying the dock clerks herself',
  invalidated: 'Corin runs the night shift at the Kiln',
  superseded: 'Vess is the harbour master',
  current: 'Hale is the harbour master now',
} as const;

const block = (text: string, name: string): string | null => {
  const m = text.match(new RegExp(`=== ${name} ===\\n([\\s\\S]*?)\\n=== END ${name} ===`));
  return m ? m[1]! : null;
};

/** Every block the statement appears in, by name. */
const whereIs = (text: string, statement: string): string[] => {
  const names = [...text.matchAll(/^=== (?!END )(.+?) ===$/gmu)].map((m) => m[1]!);
  return names.filter((n) => (block(text, n) ?? '').includes(statement));
};

describe('at chapter 30, the five planted facts', () => {
  it('has Hale as the point of view, with everything', () => {
    const pov = at30.dossiered.dossiers.find((d) => d.role === 'pov');
    expect(pov?.name).toBe('Hale');
    expect(pov?.depth).toBe('full');
    expect(at30.dossiered.scene.povEntityName).toBe('Hale');
  });

  it('respects the chapter-2 fact: it is never forbidden', () => {
    expect(whereIs(at30.brief.text, STATEMENTS.early)).not.toContain('DO NOT REVEAL');
  });

  it('does not leak the chapter-40 reveal anywhere but the negative block', () => {
    // The bar. Weight 3, true from page one, told on the last: if the statement
    // is in the brief at all it is under "do not reveal", and nowhere else.
    const places = whereIs(at30.brief.text, STATEMENTS.lateReveal);
    expect(places.every((p) => p === 'DO NOT REVEAL')).toBe(true);
    if (at30.dossiered.cast.some((c) => c.name === 'Renn')) {
      expect(places).toEqual(['DO NOT REVEAL']);
    }
  });

  it('labels what only the point of view knows, and never forbids it', () => {
    const places = whereIs(at30.brief.text, STATEMENTS.povSecret);
    expect(places).not.toContain('DO NOT REVEAL');
    expect(places.every((p) => p === 'FACTS')).toBe(true);
    const facts = block(at30.brief.text, 'FACTS') ?? '';
    const line = facts.split('\n').find((l) => l.includes(STATEMENTS.povSecret));
    if (line) expect(line).toContain('(known to Hale, not yet to the reader)');
  });

  it('says nothing that has stopped being true', () => {
    expect(whereIs(at30.brief.text, STATEMENTS.invalidated)).toEqual([]);
  });

  it('says nothing that has been replaced, and does say the replacement', () => {
    // Hale is the point of view, so his fact is always in the working set.
    expect(whereIs(at30.brief.text, STATEMENTS.superseded)).toEqual([]);
    expect(whereIs(at30.brief.text, STATEMENTS.current)).toEqual(['FACTS']);
  });

  it('derives a canon law from every admitted canon fact', () => {
    expect(at30.laws.canon.map((c) => c.factId).sort())
      .toEqual(at30.dossiered.facts.filter((f) => f.certainty === 'canon').map((f) => f.factId).sort());
    expect(block(at30.brief.text, 'CANON')).toMatch(/Everything in FACTS is canon/);
  });
});

describe('at chapter 2, the same rule from the other side', () => {
  it('has not yet been told who the harbour master is now', () => {
    // Established at 15. Not a spoiler at weight 0, so not forbidden either —
    // simply not the case yet.
    expect(whereIs(at2.brief.text, STATEMENTS.current)).toEqual([]);
  });

  it('still does not leak the reveal', () => {
    expect(whereIs(at2.brief.text, STATEMENTS.lateReveal).every((p) => p === 'DO NOT REVEAL'))
      .toBe(true);
  });
});

describe('what the scene is for', () => {
  it('carries both beats the fixture planted on it', () => {
    const beats = block(at30.brief.text, 'BEATS') ?? '';
    expect(beats).toContain('Chapter 30: the count comes up short');
    expect(beats).toContain('Ilva is asked directly, and does not answer');
    expect(beats).toContain('[Who moved the seal · payoff · turn]');
  });

  it('asks the retriever about the purpose and the beats, not the prose', () => {
    expect(at30.supplement.query).toContain('Move Hale one step closer');
    expect(at30.supplement.query).toContain('Ilva is asked directly');
  });
});

describe('the story so far', () => {
  it('ends on the last words of the scene before', () => {
    const previous = fixture.scenesByChapter[28]![1]!;
    expect(at30.ladder.tail?.sceneId).toBe(previous);
    expect(at30.brief.text.trimEnd().endsWith('=== END STORY SO FAR ===')).toBe(true);
    const story = block(at30.brief.text, 'STORY SO FAR') ?? '';
    expect(story.trimEnd().endsWith(at30.ladder.tail!.text.trimEnd().slice(-40))).toBe(true);
  });

  it('summarises the four scenes below the seam, oldest first', () => {
    const chapter = (n: number) => fixture.scenesByChapter[n - 1]!;
    const [c27, c28, c29] = [chapter(27), chapter(28), chapter(29)];
    expect(at30.ladder.scenes.map((r) => r.id)).toEqual([c27[1], c28[0], c28[1], c29[0]]);
  });

  it('names every chapter nobody has summarised, rather than skipping them', () => {
    // The fixture writes no chapter summaries. Twenty-nine chapters behind us,
    // twenty-nine gaps — the list the gap-fill screen will work through.
    expect(at30.ladder.chapters).toEqual([]);
    expect(at30.ladder.missing.filter((g) => g.rung === 'chapter')).toHaveLength(29);
  });
});

describe('the supplement', () => {
  it('finds things, and none of them is already in the brief', () => {
    expect(at30.supplement.hits.length).toBeGreaterThan(0);
    const inLadder = new Set([at30.ladder.tail?.sceneId, ...at30.ladder.scenes.map((r) => r.id)]);
    for (const h of at30.supplement.hits) {
      if (h.ownerTable === 'scene') {
        expect(h.ownerId).not.toBe(fixture.anchors.targetSceneId);
        expect(inLadder.has(h.ownerId)).toBe(false);
      }
      if (h.ownerTable === 'entity') {
        expect(at30.dossiered.dossiers.some((d) => d.entityId === h.ownerId)).toBe(false);
      }
    }
  });

  it('offers no fact the reader may not have, however well it matches', () => {
    const ids = at30.supplement.hits.filter((h) => h.ownerTable === 'fact').map((h) => h.ownerId);
    for (const banned of [fixture.anchors.lateRevealFactId, fixture.anchors.invalidatedFactId,
      fixture.anchors.supersededFactId]) {
      expect(ids).not.toContain(banned);
    }
  });
});

describe('the laws', () => {
  it('puts a voice law with its character, a house law in LAWS, and a stranger’s voice nowhere', async () => {
    const driver = await NodeSqlDriver.open();
    const f = await buildFixture(driver);
    const now = 1;
    const law = (id: string, scope: string, scopeId: string | null, category: string, text: string) =>
      driver.query(
        `INSERT INTO law (id, project_id, scope_type, scope_id, category, severity, title, rule_text,
                          created_at, updated_at) VALUES (?,?,?,?,?, 'must', ?, ?, ?, ?)`,
        [id, f.projectId, scope, scopeId, category, id, text, now, now], 'run');
    await law('house', 'project', null, 'style', 'British spelling throughout.');
    await law('hale-voice', 'pov', f.entities['Hale']!, 'voice', 'Hale never uses contractions.');
    await law('ilva-voice', 'pov', f.entities['Ilva']!, 'voice', 'Ilva speaks in fragments.');
    // Make Ilva the focus of the scene, so her entry is full and *would* carry
    // voice notes — the only depth at which the pov-scoping can be observed.
    await driver.query(
      'INSERT INTO mention (id, scene_id, entity_id, role, created_at) VALUES (?, ?, ?, ?, 1)',
      ['m-focus', f.anchors.targetSceneId, f.entities['Ilva']!, 'focus'], 'run');
    const out = (await new BriefRepository(driver).compile(f.anchors.targetSceneId, { window: 32_000 }))!;

    expect(block(out.brief.text, 'LAWS')).toContain('[house] British spelling throughout.');
    expect(block(out.brief.text, 'LAWS')).not.toContain('contractions');
    const hale = out.dossiered.dossiers.find((d) => d.name === 'Hale')!;
    expect(hale.voice.map((v) => v.ruleText)).toEqual(['Hale never uses contractions.']);
    expect(block(out.brief.text, 'CAST AND SETTING')).toContain('- [hale-voice] Hale never uses contractions. (must)');
    // Ilva is the focus — a full entry — but not the point of view: a
    // pov-scoped law for her does not apply here, and must not appear anywhere.
    const ilva = out.dossiered.dossiers.find((d) => d.name === 'Ilva')!;
    expect(ilva.depth).toBe('full');
    expect(ilva.voice).toEqual([]);
    expect(out.brief.text).not.toContain('fragments');
  });

  it('holds back an alias the reader cannot make yet, in the hop check and the dossier alike', async () => {
    // Step 5 gates the dossier's alias list itself. The gate here is for the
    // other use — step 2's second hop, which admits an entity two steps away if
    // a beat names it, *by alias*. An ungated spoiler alias in a beat would put
    // its entity in the cast in chapter 30, which is the schema's own example of
    // the failure: "the Grey Warden" == Kaelen, ch.20.
    const driver = await NodeSqlDriver.open();
    const f = await buildFixture(driver);
    const q = (sql: string, params: unknown[]) => driver.query(sql, params, 'run');
    const vess = f.entities['Vess']!;
    const ledger = f.entities['the ledger']!;
    // Vess is two hops from the room: Renn is present and holds the ledger,
    // which is not in the scene; the ledger was Vess's. One hop admits the
    // ledger; only a beat naming Vess can admit Vess.
    const relate = (id: string, from: string, to: string, kind: string) => q(
      `INSERT INTO entity_relationship (id, project_id, from_entity_id, to_entity_id, kind,
                                        created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [id, f.projectId, from, to, kind]);
    await relate('r-holds', f.entities['Renn']!, ledger, 'holds');
    await relate('r-was', ledger, vess, 'belonged_to');
    await q(
      `INSERT INTO entity_alias (id, entity_id, alias, kind, created_at, linkable_from_scene_id)
       VALUES ('a-later', ?, 'the man who moved the seal', 'epithet', 1, ?)`,
      [vess, f.scenesByChapter[39]![0]!]);
    await q(
      `INSERT INTO entity_alias (id, entity_id, alias, kind, created_at, linkable_from_scene_id)
       VALUES ('a-now', ?, 'the old harbour master', 'epithet', 1, NULL)`, [vess]);
    const arcId = ((await driver.query('SELECT id FROM arc LIMIT 1', [], 'all')).rows as string[][])[0]![0]!;
    await q(
      `INSERT INTO beat (id, arc_id, sort_key, title, status, created_at, updated_at)
       VALUES ('b-test', ?, 'zz', 'She finally meets the man who moved the seal', 'planned', 1, 1)`, [arcId]);
    await q('INSERT INTO beat_scene (beat_id, scene_id, role) VALUES (?, ?, ?)',
      ['b-test', f.anchors.targetSceneId, 'develop']);

    const out = (await new BriefRepository(driver).compile(f.anchors.targetSceneId, { window: 32_000 }))!;
    expect(out.dossiered.cast.some((c) => c.name === 'Renn')).toBe(true);
    expect(out.dossiered.cast.some((c) => c.entityId === ledger)).toBe(true);
    // The beat names Vess only by the alias the reader cannot make yet, so the
    // second hop does not fire and Vess stays out.
    expect(out.dossiered.cast.some((c) => c.entityId === vess)).toBe(false);
    // His name may well be in the story so far — he was the point of view of
    // earlier scenes — but there is no entry for him.
    expect(out.dossiered.dossiers.some((d) => d.entityId === vess)).toBe(false);
    expect(block(out.brief.text, 'CAST AND SETTING')).not.toContain('Vess');

    // Name him by an alias the reader has, and the same hop admits him.
    await q('UPDATE beat SET title = ? WHERE id = ?', ['She finally meets the old harbour master', 'b-test']);
    const again = (await new BriefRepository(driver).compile(f.anchors.targetSceneId, { window: 32_000 }))!;
    expect(again.dossiered.cast.some((c) => c.entityId === vess)).toBe(true);
    const dossier = again.dossiered.dossiers.find((d) => d.entityId === vess)!;
    expect(dossier.depth).toBe('name-only');
    expect(dossier.aliases).toEqual([]);
  });
});

describe('the ban list', () => {
  it('finds the repeated imagery and never a name', () => {
    expect(at30.laws.bans.phrases.length).toBeGreaterThan(0);
    for (const p of [...at30.laws.bans.phrases, ...at30.laws.bans.words]) {
      for (const name of ['ilva', 'renn', 'masha', 'corin', 'vess', 'hale']) {
        expect(p.split(' ')).not.toContain(name);
      }
    }
    expect(at30.laws.bans.openings.length).toBeGreaterThan(0);
  });
});

describe('the budget', () => {
  it('fits a 32k window with room to answer, and says what it used', () => {
    expect(at30.brief.overflow).toBe(false);
    expect(at30.brief.used).toBeLessThanOrEqual(at30.brief.window - at30.brief.outputReserve);
    expect(at30.brief.sections.filter((s) => s.allowed === null).map((s) => s.key))
      .toEqual(['scene', 'beats', 'laws', 'negative', 'canon', 'bans']);
  });

  it('compiles the same brief twice', async () => {
    const driver = await NodeSqlDriver.open();
    const f = await buildFixture(driver);
    const repo = new BriefRepository(driver);
    const a = await repo.compile(f.anchors.targetSceneId, { window: 32_000 });
    const b = await repo.compile(f.anchors.targetSceneId, { window: 32_000 });
    expect(a!.brief.text).toBe(b!.brief.text);
    expect(a!.brief.text).toBe(at30.brief.text);
  });

  it('keeps the beats and the negative block when squeezed into a small model', async () => {
    // A window with room for the fixed blocks and about 250 tokens over, so
    // every flexible section has to give something up and nothing overflows.
    const fixed = at30.brief.sections.filter((s) => s.allowed === null).reduce((n, s) => n + s.tokens, 0);
    const driver = await NodeSqlDriver.open();
    const f = await buildFixture(driver);
    const small = (await new BriefRepository(driver)
      .compile(f.anchors.targetSceneId, { window: Math.round((fixed + 250) / 0.9) }))!;
    expect(small.brief.overflow).toBe(false);
    expect(block(small.brief.text, 'BEATS')).toContain('the count comes up short');
    expect(whereIs(small.brief.text, STATEMENTS.lateReveal).every((p) => p === 'DO NOT REVEAL')).toBe(true);
    for (const key of ['cast', 'facts', 'continuity']) {
      expect(small.brief.sections.find((s) => s.key === key)!.trimmed.length).toBeGreaterThan(0);
    }
    expect(small.brief.used).toBeLessThanOrEqual(small.brief.window - small.brief.outputReserve);
  });

  it('pre-judges a fact about somebody outside the cast before the retriever sees it', async () => {
    // Vess is not in the chapter-30 cast, so step 3 never rules on "Vess is the
    // harbour master" — and the supplement's own gate is the revealed rank,
    // which that fact passes. Only the repository's visibility pass over every
    // fact keeps a replaced fact out of RELATED. Point the purpose straight at
    // it and check it still does not come.
    const driver = await NodeSqlDriver.open();
    const f = await buildFixture(driver);
    await driver.query(
      'UPDATE scene SET purpose = ? WHERE id = ?',
      ['Find out who the harbour master is, and who it used to be.', f.anchors.targetSceneId], 'run');
    const out = (await new BriefRepository(driver).compile(f.anchors.targetSceneId, { window: 32_000 }))!;
    expect(out.dossiered.cast.some((c) => c.name === 'Vess')).toBe(false);
    expect(whereIs(out.brief.text, STATEMENTS.superseded)).toEqual([]);
    expect(out.supplement.hits.map((h) => h.ownerId)).not.toContain(f.anchors.supersededFactId);
    // The replacement is Hale's, and Hale is the point of view: in FACTS, and so
    // not offered a second time as a supplement.
    expect(whereIs(out.brief.text, STATEMENTS.current)).toEqual(['FACTS']);
  });

  it('returns null for a scene that is not there', async () => {
    const driver = await NodeSqlDriver.open();
    await buildFixture(driver);
    expect(await new BriefRepository(driver).compile('no-such-scene')).toBeNull();
  });
});
