import type { SqlDriver } from '../db/driver';
import { firstKey, initialKeys, sceneGlobalRank } from '../domain/sortKey';
import { rng } from '../spike/corpus';
import { countWords } from '../text/words';
import { rebuildKind } from '../index/rebuild';

/**
 * The fixture novel — the instrument Phase 2 is measured with.
 *
 * Doc 08's Phase 2 bar is a comparison, not a demo: *on the fixture novel, a
 * scene drafted at chapter 30 correctly respects facts established in chapter 2
 * and does not leak a chapter-40 reveal — and a big-dump control prompt fails at
 * least one of those.* That sentence needs a manuscript built to make it
 * answerable, and no real book can be one: [D14](../../docs/10-decisions.md)
 * keeps manuscript content out of this repository entirely.
 *
 * So this is generated from a seed at run time and never committed, the same way
 * `spike/corpus.ts` is — there is no fixture file, so there is nothing to leak.
 * The difference is what it generates. The corpus is two thousand random facts
 * across random entities: exactly right for measuring FTS and OPFS, and useless
 * here, because nothing in it is *about* anything.
 *
 * **This is an instrument, not a data set.** It returns `anchors` — the specific
 * ids the comparison names — because a fixture you have to go hunting through to
 * find the chapter-40 reveal is a fixture whose test will quietly drift onto the
 * wrong row. Every planted fact exists to make one branch of the spoiler rule
 * fire at chapter 30, and `novel.test.ts` proves each of them does before Phase 2
 * relies on it. A fixture that does not discriminate makes a green test that
 * means nothing.
 */

export interface FixtureSpec {
  seed: number;
  /** At least 41: the reveal lands in chapter 40 and must be ahead of the target. */
  chapters: number;
  scenesPerChapter: number;
  /**
   * Prose per scene. Deliberately short — the structure is what is under test,
   * and a hundred thousand words of generated filler would only make the suite
   * slow. Raise it when measuring the continuity ladder's compression.
   */
  wordsPerScene: number;
}

export const FIXTURE: FixtureSpec = {
  seed: 20260914,
  chapters: 42,
  scenesPerChapter: 2,
  wordsPerScene: 120,
};

/** Chapters are 1-based here, matching how the bar is written. */
const ESTABLISHED_EARLY = 2;
const REVEAL_LATE = 40;
const POV_LEARNS = 12;
const POV_REVEALED = 38;
const INVALIDATED_AT = 20;
const TARGET_CHAPTER = 30;

export interface FixtureAnchors {
  /** Where drafting happens: chapter 30, first scene. */
  targetSceneId: string;
  targetSceneRank: string;
  /** The POV of the target scene. */
  povEntityId: string;
  /** Established and told in chapter 2. Must be respected at chapter 30. */
  earlyFactId: string;
  /** True all along, told only in chapter 40, weight 3. Must not leak. */
  lateRevealFactId: string;
  /** The POV learns it in chapter 12; the reader is not told until 38. */
  povSecretFactId: string;
  /** True from chapter 3, no longer true from chapter 20. */
  invalidatedFactId: string;
  /** Replaced by a later fact that is active at chapter 30. */
  supersededFactId: string;
}

export interface Fixture {
  spec: FixtureSpec;
  projectId: string;
  bookId: string;
  /** Scene ids by chapter, 0-based outer index. */
  scenesByChapter: string[][];
  entities: Record<string, string>;
  anchors: FixtureAnchors;
}

/* ------------------------------------------------------------------- people */

const CHARACTERS = ['Ilva', 'Renn', 'Masha', 'Corin', 'Vess', 'Hale'] as const;
const PLACES = ['the Harbour', 'the Long Hall', 'the Kiln'] as const;
const THINGS = ['the seal', 'the ledger'] as const;

/**
 * Plausible sentences, deterministic from the seed.
 *
 * Ordinary English rather than the invented syllables the performance corpus
 * uses. Those are right for measuring an FTS index and wrong for this: the
 * prose here is read by the mention matcher, by the repetition guard, and
 * eventually by a model, and none of them behave the same way on nonsense.
 * Entity names appear in it on purpose, so the graph has something to find.
 */
const SENTENCES = [
  '{who} crossed {place} before the light went.',
  'Nobody at {place} would say what had happened to {thing}.',
  '{who} counted the crates twice and got a different number.',
  'The rain came in off the water and stayed all evening.',
  '{who} had not spoken to {other} since the spring.',
  '{thing} lay where {who} had left it, and that was the trouble.',
  'At {place} the doors were open, which meant somebody was waiting.',
  '{who} said nothing, which {other} took badly.',
  'The ledger was short by a page and no one admitted to it.',
  '{who} went out to {place} and came back wetter and no wiser.',
  'It was the kind of quiet that costs money.',
  '{other} asked the question twice, and {who} answered neither time.',
];

function prose(r: () => number, words: number, cast: readonly string[]): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const out: string[] = [];
  let count = 0;
  while (count < words) {
    const who = pick(cast);
    let other = pick(cast);
    if (other === who) other = cast[(cast.indexOf(who) + 1) % cast.length]!;
    const line = pick(SENTENCES)
      .replace('{who}', who)
      .replace(/\{other\}/gu, other)
      .replace(/\{place\}/gu, pick(PLACES))
      .replace(/\{thing\}/gu, pick(THINGS));
    out.push(line);
    count += countWords(line).words;
  }
  // Paragraphs of two or three sentences, so the diff and the continuity ladder
  // have real paragraph boundaries to work with.
  const paragraphs: string[] = [];
  for (let i = 0; i < out.length; i += 3) paragraphs.push(out.slice(i, i + 3).join(' '));
  return paragraphs.join('\n\n');
}

const docOf = (text: string) => JSON.stringify({
  type: 'doc',
  content: text.split(/\n{2,}/u).map((p) => ({
    type: 'paragraph', content: [{ type: 'text', text: p }],
  })),
});

/* ------------------------------------------------------------------- build */

interface Statement { sql: string; params: unknown[] }

/**
 * Build the whole thing. Ids are derived from the seed, so two runs of the same
 * spec produce the same manuscript and a failing assertion can be re-read.
 */
export async function buildFixture(
  driver: SqlDriver, spec: FixtureSpec = FIXTURE, projectId = 'fixture-novel',
): Promise<Fixture> {
  if (spec.chapters <= REVEAL_LATE) {
    throw new Error(`the reveal lands in chapter ${REVEAL_LATE}; the book needs more than that`);
  }
  const r = rng(spec.seed);
  const now = 1_760_000_000_000;
  let n = 0;
  const id = (kind: string) => `${kind}-${String(++n).padStart(4, '0')}`;

  const writes: Statement[] = [];
  const bookId = id('book');
  writes.push(
    {
      sql: 'INSERT INTO project (id,title,premise,created_at,updated_at) VALUES (?,?,?,?,?)',
      params: [projectId, 'The Weight of Water',
        'A clerk who counts what other people would rather was not counted.', now, now],
    },
    {
      sql: `INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at)
            VALUES (?,?,?,?,?,?)`,
      params: [bookId, projectId, 'The Weight of Water', firstKey(), now, now],
    },
  );

  // ---- codex -------------------------------------------------------------
  const entities: Record<string, string> = {};
  const named = [
    ...CHARACTERS.map((name) => ({ name, typeKey: 'character' })),
    ...PLACES.map((name) => ({ name, typeKey: 'location' })),
    ...THINGS.map((name) => ({ name, typeKey: 'item' })),
  ];
  for (const [i, e] of named.entries()) {
    const entityId = id('entity');
    entities[e.name] = entityId;
    writes.push(
      {
        sql: `INSERT INTO entity (id,project_id,type_key,name,summary,importance,maturity,
                created_at,updated_at)
              VALUES (?,?,?,?,?,?, 'adult', ?,?)`,
        params: [entityId, projectId, e.typeKey, e.name,
          `${e.name}, who the book keeps returning to.`,
          i === 0 ? 'protagonist' : i < 3 ? 'major' : 'minor', now, now],
      },
      {
        sql: `INSERT INTO entity_alias (id,entity_id,alias,kind,is_primary,created_at)
              VALUES (?,?,?, 'name', 1, ?)`,
        params: [id('alias'), entityId, e.name, now],
      },
    );
  }

  // ---- chapters and scenes ----------------------------------------------
  const chapterKeys = initialKeys(spec.chapters);
  const sceneKeys = initialKeys(spec.scenesPerChapter);
  const scenesByChapter: string[][] = [];
  const rankOf = new Map<string, string>();

  for (let c = 0; c < spec.chapters; c++) {
    const chapterId = id('chapter');
    writes.push({
      sql: `INSERT INTO chapter (id,book_id,number,title,sort_key,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: [chapterId, bookId, c + 1, `Chapter ${c + 1}`, chapterKeys[c], now, now],
    });

    const inChapter: string[] = [];
    for (let s = 0; s < spec.scenesPerChapter; s++) {
      const sceneId = id('scene');
      const rank = sceneGlobalRank({
        bookKey: firstKey(), chapterKey: chapterKeys[c]!, sceneKey: sceneKeys[s]!,
      });
      rankOf.set(sceneId, rank);
      const pov = CHARACTERS[(c + s) % CHARACTERS.length]!;
      const text = prose(r, spec.wordsPerScene, CHARACTERS);
      writes.push({
        sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,summary,purpose,
                pov_entity_id,pov_mode,tense,content_json,content_text,word_count,status,
                created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?, 'close_third','past', ?,?,?, 'drafted', ?,?)`,
        params: [
          sceneId, chapterId, `Chapter ${c + 1}, scene ${s + 1}`, sceneKeys[s], rank,
          `${pov} at ${PLACES[(c + s) % PLACES.length]}, and it does not go well.`,
          `Move ${pov} one step closer to knowing what the ledger is for.`,
          entities[pov], docOf(text), text, countWords(text).words, now, now,
        ],
      });
      inChapter.push(sceneId);
    }
    scenesByChapter.push(inChapter);
  }

  const sceneAt = (chapter: number, scene = 0) => scenesByChapter[chapter - 1]![scene]!;
  const targetSceneId = sceneAt(TARGET_CHAPTER);

  // ---- arcs and beats ----------------------------------------------------
  const arcKeys = initialKeys(3);
  const arcs = [
    { name: 'Ilva learns what the ledger is for', kind: 'main_plot' },
    { name: 'Renn decides whose side he is on', kind: 'character' },
    { name: 'Who moved the seal', kind: 'mystery' },
  ];
  const arcIds = arcs.map((a, i) => {
    const arcId = id('arc');
    writes.push({
      sql: `INSERT INTO arc (id,book_id,kind,name,sort_key,status,created_at,updated_at)
            VALUES (?,?,?,?,?, 'planned', ?,?)`,
      params: [arcId, bookId, a.kind, a.name, arcKeys[i], now, now],
    });
    return arcId;
  });

  // One beat every third chapter, carried by that chapter's first scene. The
  // cadence starts at 3 rather than 1 so that it lands ON the target chapter:
  // starting at 1 gives 1, 4, 7 … which steps over chapter 30, and the target
  // scene would have carried only the extra beat below. A fixture whose most
  // important scene is the least typical one is not a fixture.
  const beatKeys = initialKeys(Math.ceil(spec.chapters / 3) + 2);
  let beatN = 0;
  for (let c = 3; c <= spec.chapters; c += 3) {
    const arcIndex = (c / 3 | 0) % arcIds.length;
    const beatId = id('beat');
    writes.push(
      {
        sql: `INSERT INTO beat (id,arc_id,sort_key,title,summary,function,tension,
                target_chapter_id,status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,NULL,'planned',?,?)`,
        params: [beatId, arcIds[arcIndex], beatKeys[beatN++],
          `Chapter ${c}: the count comes up short`,
          'Somebody notices, and says the wrong thing about it.',
          c === 1 ? 'setup' : c > spec.chapters - 4 ? 'climax' : 'turn',
          Math.min(10, 2 + Math.floor((c / spec.chapters) * 8)), now, now],
      },
      {
        sql: 'INSERT INTO beat_scene (beat_id,scene_id,role) VALUES (?,?, \'develop\')',
        params: [beatId, sceneAt(c)],
      },
    );
  }
  const extraBeatId = id('beat');
  writes.push(
    {
      sql: `INSERT INTO beat (id,arc_id,sort_key,title,summary,function,tension,
              target_chapter_id,status,created_at,updated_at)
            VALUES (?,?,?,?,?, 'turn', 7, NULL, 'planned', ?,?)`,
      params: [extraBeatId, arcIds[2], beatKeys[beatN],
        'Ilva is asked directly, and does not answer',
        'The question she cannot answer without giving away what she was told.', now, now],
    },
    {
      sql: 'INSERT INTO beat_scene (beat_id,scene_id,role) VALUES (?,?, \'payoff\')',
      params: [extraBeatId, targetSceneId],
    },
  );

  // ---- the planted facts -------------------------------------------------
  const povEntityId = entities[CHARACTERS[(TARGET_CHAPTER - 1) % CHARACTERS.length]!]!;
  const fact = (
    subject: string, predicate: string, object: string,
    over: {
      established?: string | null; revealed?: string | null; invalidated?: string | null;
      supersedes?: string | null; weight?: number;
    },
  ) => {
    const factId = id('fact');
    writes.push({
      sql: `INSERT INTO fact (id,project_id,subject_entity_id,predicate,object_text,statement,
              established_at_scene_id,revealed_at_scene_id,invalidated_at_scene_id,
              supersedes_fact_id,certainty,spoiler_weight,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?, 'canon', ?,?,?)`,
      params: [factId, projectId, entities[subject], predicate, object,
        `${subject} ${predicate} ${object}`,
        over.established ?? null, over.revealed ?? null, over.invalidated ?? null,
        over.supersedes ?? null, over.weight ?? 0, now, now],
    });
    return factId;
  };

  const earlyFactId = fact('Ilva', 'keeps', 'the ledger for the harbour master',
    { established: sceneAt(ESTABLISHED_EARLY), revealed: sceneAt(ESTABLISHED_EARLY), weight: 0 });

  // True from the first page and told on the last: the thing a brief compiled at
  // chapter 30 must not so much as hint at.
  const lateRevealFactId = fact('Renn', 'is', 'the one who moved the seal',
    { established: null, revealed: sceneAt(REVEAL_LATE), weight: 3 });

  const povSecretFactId = fact('Masha', 'has been', 'paying the dock clerks herself',
    { established: sceneAt(3), revealed: sceneAt(POV_REVEALED), weight: 2 });
  writes.push({
    sql: `INSERT INTO fact_knowledge (id,fact_id,entity_id,belief,known_from_scene_id,
            learned_how,created_at)
          VALUES (?,?,?, 'knows', ?, ?, ?)`,
    params: [id('know'), povSecretFactId, povEntityId, sceneAt(POV_LEARNS),
      'She was in the room when the money changed hands.', now],
  });

  const invalidatedFactId = fact('Corin', 'runs', 'the night shift at the Kiln',
    { established: sceneAt(3), revealed: sceneAt(3), invalidated: sceneAt(INVALIDATED_AT) });

  const supersededFactId = fact('Vess', 'is', 'the harbour master',
    { established: null, revealed: sceneAt(4) });
  fact('Hale', 'is', 'the harbour master now',
    { established: sceneAt(15), revealed: sceneAt(15), supersedes: supersededFactId });

  // Filler, so the target scene's brief has to choose rather than take everything.
  for (let i = 0; i < 12; i++) {
    const c = 1 + Math.floor(r() * (spec.chapters - 2));
    fact(CHARACTERS[i % CHARACTERS.length]!, 'was seen at',
      PLACES[i % PLACES.length]!, { established: sceneAt(c), revealed: sceneAt(c) });
  }

  await driver.batch(writes, true);

  // Mentions and search, through the rebuilders rather than by hand.
  //
  // Step 1 of the compiler seeds the brief from `mention` rows, so a fixture
  // without them has no cast and every dossier comes out empty. Building them
  // with the real rebuilder rather than inserting rows here means the fixture
  // cannot drift from what the app itself would derive — and it is the same
  // path a writer's own manuscript takes.
  await rebuildKind(driver, projectId, 'mention');
  await rebuildKind(driver, projectId, 'fts');

  return {
    spec,
    projectId,
    bookId,
    scenesByChapter,
    entities,
    anchors: {
      targetSceneId,
      targetSceneRank: rankOf.get(targetSceneId)!,
      povEntityId,
      earlyFactId,
      lateRevealFactId,
      povSecretFactId,
      invalidatedFactId,
      supersededFactId,
    },
  };
}
