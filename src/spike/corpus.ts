/**
 * Deterministic synthetic corpus.
 *
 * Generated from a seed at run time and NEVER committed. That is the point:
 * there is no fixture file, so there is nothing to leak, and D14 holds by
 * construction rather than by discipline. Same seed, same corpus, on any
 * machine — so the Gate A numbers are comparable across environments.
 */

/** mulberry32 — small, fast, and identical everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSET = ['b','br','d','dr','f','g','gr','h','k','kr','l','m','n','p','r','s','sh','st','t','th','v','w','z'];
const NUCLEUS = ['a','e','i','o','u','ae','ei','ou','ia','au'];
const CODA = ['','n','r','l','s','th','k','m','ld','rn','st'];

function word(r: () => number): string {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  let w = pick(ONSET) + pick(NUCLEUS) + pick(CODA);
  if (r() < 0.35) w += pick(NUCLEUS) + pick(CODA);
  return w;
}

/** A fixed lexicon gives FTS a realistic Zipf-ish term distribution to index. */
function lexicon(r: () => number, size: number): string[] {
  const seen = new Set<string>();
  while (seen.size < size) seen.add(word(r));
  return [...seen];
}

export interface CorpusSpec {
  seed: number;
  scenes: number;
  wordsPerScene: number;
  versionsPerScene: number;
  entities: number;
  facts: number;
  chapters: number;
  /** Lexicon size; larger means a bigger FTS index for the same word count. */
  vocabulary: number;
}

export const DEFAULT_SPEC: CorpusSpec = {
  seed: 20260913,
  scenes: 300,
  wordsPerScene: 500, // 300 x 500 = 150,000 words
  versionsPerScene: 5,
  entities: 200,
  facts: 2000,
  chapters: 30,
  vocabulary: 4000,
};

export interface Corpus {
  spec: CorpusSpec;
  sceneIds: string[];
  entityIds: string[];
  /** Terms guaranteed to exist in the prose — for honest FTS timing. */
  probeTerms: string[];
  /** A term that appears in roughly one scene — worst case for FTS. */
  rareTerm: string;
  statements: { sql: string; params: unknown[] }[][];
  totalWords: number;
}

const now = 1_760_000_000_000;

export function buildCorpus(spec: CorpusSpec = DEFAULT_SPEC): Corpus {
  const r = rng(spec.seed);
  const vocab = lexicon(r, spec.vocabulary);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

  // Zipf-ish: low indices are common, high indices are rare.
  const zipf = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.abs(r() ** 3) * vocab.length))]!;

  const prose = (n: number): string => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(zipf());
    // Sentence shape, so the porter tokenizer and any later word counter see
    // something structurally like prose rather than a bag of tokens.
    let s = '';
    for (let i = 0; i < out.length; i += 12) {
      const chunk = out.slice(i, i + 12);
      chunk[0] = chunk[0]!.charAt(0).toUpperCase() + chunk[0]!.slice(1);
      s += chunk.join(' ') + '. ';
    }
    return s.trim();
  };

  const batches: { sql: string; params: unknown[] }[][] = [];
  const projectId = 'pr_0001';
  const bookId = 'bk_0001';

  const head: { sql: string; params: unknown[] }[] = [];
  for (const [key, label] of [
    ['character', 'Character'], ['location', 'Location'], ['faction', 'Faction'],
    ['item', 'Item'], ['event', 'Event'], ['concept', 'Concept'], ['language', 'Language'],
  ] as const) {
    // NOTE: the schema ships no seed data for entity_type. Phase 1 needs a real
    // seed migration; the corpus does it here so Gate A can run.
    head.push({ sql: 'INSERT INTO entity_type (key, label) VALUES (?,?)', params: [key, label] });
  }
  head.push({
    sql: `INSERT INTO project (id,title,premise,created_at,updated_at) VALUES (?,?,?,?,?)`,
    params: [projectId, 'The Grey Warden', prose(40), now, now],
  });
  head.push({
    sql: `INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    params: [bookId, projectId, 'Book One', 'm', now, now],
  });
  batches.push(head);

  // Entities
  const entityIds: string[] = [];
  const entBatch: { sql: string; params: unknown[] }[] = [];
  for (let i = 0; i < spec.entities; i++) {
    const id = `en_${String(i).padStart(5, '0')}`;
    entityIds.push(id);
    const importance = i < 4 ? 'protagonist' : i < 25 ? 'major' : i < 100 ? 'minor' : 'background';
    entBatch.push({
      sql: `INSERT INTO entity (id,project_id,type_key,name,summary,description,importance,maturity,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [id, projectId, pick(['character','location','faction','item','concept']),
        word(r).replace(/^./, (c) => c.toUpperCase()), prose(15), prose(120), importance, 'adult', now, now],
    });
    entBatch.push({
      sql: `INSERT INTO entity_alias (id,entity_id,alias,kind,is_primary,created_at) VALUES (?,?,?,?,1,?)`,
      params: [`al_${String(i).padStart(5, '0')}`, id, word(r), 'name', now],
    });
  }
  batches.push(entBatch);

  // Chapters
  const chapBatch: { sql: string; params: unknown[] }[] = [];
  const chapterIds: string[] = [];
  for (let i = 0; i < spec.chapters; i++) {
    const id = `ch_${String(i).padStart(4, '0')}`;
    chapterIds.push(id);
    chapBatch.push({
      sql: `INSERT INTO chapter (id,book_id,number,title,sort_key,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      params: [id, bookId, i + 1, `Chapter ${i + 1}`, String(i).padStart(6, '0'), prose(60), now, now],
    });
  }
  batches.push(chapBatch);

  // Scenes, versions, mentions, FTS
  const sceneIds: string[] = [];
  const probeTerms = new Set<string>();
  let totalWords = 0;
  let rareTerm = '';

  for (let i = 0; i < spec.scenes; i++) {
    const b: { sql: string; params: unknown[] }[] = [];
    const id = `sc_${String(i).padStart(5, '0')}`;
    sceneIds.push(id);
    const chapterId = chapterIds[Math.floor(i / (spec.scenes / spec.chapters))] ?? chapterIds[0]!;
    const body = prose(spec.wordsPerScene);
    totalWords += spec.wordsPerScene;
    if (i % 40 === 0) probeTerms.add(body.split(' ')[3]!.toLowerCase().replace(/\W/g, ''));
    // One term planted in exactly one scene: the worst case for FTS.
    if (i === Math.floor(spec.scenes / 2)) {
      rareTerm = 'zzqx' + word(r);
    }
    const text = i === Math.floor(spec.scenes / 2) ? `${body} ${rareTerm}.` : body;

    b.push({
      sql: `INSERT INTO scene (id,chapter_id,title,sort_key,global_rank,summary,purpose,pov_entity_id,
              tension,word_count,status,content_text,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [id, chapterId, `Scene ${i + 1}`, String(i).padStart(6, '0'), String(i).padStart(9, '0'),
        prose(30), prose(12), entityIds[i % 4]!, Math.floor(r() * 11), spec.wordsPerScene, 'drafted', text, now, now],
    });
    b.push({
      sql: `INSERT INTO scene_fts (scene_id,title,content_text) VALUES (?,?,?)`,
      params: [id, `Scene ${i + 1}`, text],
    });

    for (let v = 0; v < spec.versionsPerScene; v++) {
      b.push({
        sql: `INSERT INTO scene_version (id,scene_id,label,origin,content_text,word_count,is_active,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [`sv_${String(i).padStart(5, '0')}_${v}`, id, `draft ${v + 1}`,
          v === 0 ? 'manual' : 'ai_draft', prose(spec.wordsPerScene), spec.wordsPerScene,
          v === spec.versionsPerScene - 1 ? 1 : 0, now + v],
      });
    }

    // ~50 mentions per scene — the derived table the brief compiler seeds from.
    const roles = ['pov', 'focus', 'present', 'mentioned'] as const;
    for (let m = 0; m < 50; m++) {
      const eIdx = Math.floor(Math.abs(r() ** 2) * spec.entities);
      b.push({
        sql: `INSERT INTO mention (id,scene_id,entity_id,role,method,created_at) VALUES (?,?,?,?,?,?)`,
        params: [`mn_${String(i).padStart(5, '0')}_${m}`, id, entityIds[eIdx] ?? entityIds[0]!,
          m === 0 ? 'pov' : pick(roles), 'alias_match', now],
      });
    }
    batches.push(b);
  }

  // Facts, with both time axes populated — the thing the whole product is about.
  const factBatch: { sql: string; params: unknown[] }[] = [];
  for (let i = 0; i < spec.facts; i++) {
    const est = Math.floor(r() * spec.scenes);
    const rev = Math.min(spec.scenes - 1, est + Math.floor(r() * 60));
    factBatch.push({
      sql: `INSERT INTO fact (id,project_id,subject_entity_id,predicate,statement,
              established_at_scene_id,revealed_at_scene_id,spoiler_weight,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [`fa_${String(i).padStart(5, '0')}`, projectId,
        entityIds[Math.floor(r() * spec.entities)]!, pick(['is','knows','owns','fears','killed','loves']),
        prose(14), sceneIds[est]!, sceneIds[rev]!, Math.floor(r() * 4), now, now],
    });
  }
  batches.push(factBatch);

  return {
    spec, sceneIds, entityIds,
    probeTerms: [...probeTerms].filter((t) => t.length > 3),
    rareTerm, statements: batches, totalWords,
  };
}
