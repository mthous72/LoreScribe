import type { SqlDriver } from '../db/driver';
import { globalRank } from '../domain/sortKey';
import { factVisibilityAt, isKnowing, type FactForVisibility } from '../domain/factVisibility';
import {
  attachFacts, expandOneHop, renderDossiers, seedBrief,
  type AliasRow, type BeatRow, type Dossiered, type EntityRow, type FactRow,
  type MentionRow, type RelationshipRow, type SceneRow, type VoiceNote,
} from '../domain/sceneBrief';
import {
  continuityLadder,
  type Ladder, type LadderChapter, type LadderPart, type LadderScene,
} from '../domain/continuityLadder';
import {
  semanticSupplement, supplementQuery, type Candidate, type Supplement, type SupplementHit,
} from '../domain/semanticSupplement';
import { gatherLaws, referenceBand, type LawRow, type LawScope, type Laws } from '../domain/lawsAndBans';
import { compileBrief, type CompiledBrief, type TokenCounter } from '../domain/briefBudget';
import { ftsAnyOf } from './searchQuery';

/**
 * The scene brief, from the database.
 *
 * Every rule lives in `src/domain` and is tested there without a database.
 * This is the read that feeds them and the order they run in — the one place
 * the nine steps are wired together, so there is exactly one answer to "what
 * does the model see for this scene", and the inspector shows that answer.
 *
 * Reads are by project rather than by scene wherever the domain step needs the
 * whole set to be right: all facts, because supersession is a relation and a
 * replacement about somebody outside the working set still does its work; all
 * relationships, because a hop has to see both ends; all laws, because scope
 * is decided in step 8 and not here. A project is a novel, not a warehouse, and
 * one round trip per table is cheaper than the bug of a filter applied too
 * early.
 *
 * **Fact candidates for step 7 are pre-judged here.** The supplement's own gate
 * is the revealed rank, which is a spoiler check; a fact that is *wrong* at this
 * point — invalidated, or superseded — is not a spoiler and would pass it. The
 * repository has every fact and runs the visibility rule over all of them once,
 * so a fact reaches the retriever's candidate list only if the reader may have
 * it. Step 7's gate stays as the second lock on the same door.
 *
 * Two inputs are placeholders and say so: the reference band is empty until
 * the import module writes `source_band = 'reference'` embeddings, and style
 * exemplars are whatever the caller passes — doc 04 says they are the writer's
 * own scenes, and choosing which is a later feature.
 */

export interface SceneBriefResult {
  brief: CompiledBrief;
  dossiered: Dossiered;
  ladder: Ladder;
  supplement: Supplement;
  laws: Laws;
  reference: SupplementHit[];
}

export interface CompileOptions {
  /** The target model's context window. A placeholder until a provider says. */
  window?: number;
  outputReserve?: number;
  count?: TokenCounter;
  /** The writer's own prose, chosen by the caller. */
  exemplars?: readonly string[];
  supplementLimit?: number;
}

const DEFAULT_WINDOW = 32_000;
const CANDIDATES = 40;
const SCENE_RANK = 'bm25(scene_fts, 0.0, 10.0, 1.0)';
const CODEX_RANK = 'bm25(codex_fts, 0.0, 0.0, 10.0, 1.0)';

interface SceneHead extends SceneRow {
  contentText: string | null;
  chapterId: string;
  bookId: string;
  bookKey: string;
  projectId: string;
}

export class BriefRepository {
  constructor(private readonly driver: SqlDriver) {}

  async #all(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return (await this.driver.query(sql, params, 'all')).rows as unknown[][];
  }

  /** Null when the scene does not exist or has been deleted. */
  async compile(sceneId: string, options: CompileOptions = {}): Promise<SceneBriefResult | null> {
    const head = await this.#scene(sceneId);
    if (!head) return null;
    const { projectId, bookId, chapterId, globalRank: atRank } = head;

    const [entities, mentions, beats, relationships, factRows, aliasRows, lawRows, structure] =
      await Promise.all([
        this.#entities(projectId),
        this.#mentions(sceneId),
        this.#beats(sceneId),
        this.#relationships(projectId),
        this.#facts(projectId),
        this.#aliases(projectId),
        this.#laws(projectId),
        this.#structure(bookId, head.bookKey),
      ]);

    // Aliases the reader may make by now, for both the hop check and the
    // dossier — one gate, so an alias that is itself a spoiler cannot admit its
    // entity through the beats and then be hidden from the cast list.
    const usable = aliasRows.filter((a) => a.linkableFromRank === null || a.linkableFromRank <= atRank);
    const aliasNames = new Map<string, string[]>();
    for (const a of usable) aliasNames.set(a.entityId, [...(aliasNames.get(a.entityId) ?? []), a.alias]);

    const seed = seedBrief({ scene: head, mentions, entities, beats });
    const expanded = expandOneHop({ seed, atRank, relationships, entities, aliases: aliasNames });
    const briefed = attachFacts({ expanded, atRank, facts: factRows });
    const dossiered = renderDossiers({
      briefed, atRank, aliases: usable,
      voiceNotes: voiceNotesFrom(lawRows, head.povEntityId),
    });

    const ladder = continuityLadder({
      atRank, chapterId,
      scenes: structure.scenes, chapters: structure.chapters, parts: structure.parts,
    });

    const candidates = await this.#candidates(
      projectId, atRank, head.povEntityId, briefed, factRows, entities);
    const supplement = semanticSupplement({
      briefed, ladder, atRank, candidates, limit: options.supplementLimit,
    });

    const laws = gatherLaws({
      briefed, bookId, chapterId, laws: lawRows,
      scenes: structure.scenes, currentText: head.contentText,
    });

    const reference = referenceBand([]);

    const brief = compileBrief({
      dossiered, ladder, supplement, laws, reference,
      exemplars: options.exemplars ?? [],
      window: options.window ?? DEFAULT_WINDOW,
      options: { outputReserve: options.outputReserve, count: options.count },
    });

    return { brief, dossiered, ladder, supplement, laws, reference };
  }

  /* ------------------------------------------------------------------ reads */

  async #scene(sceneId: string): Promise<SceneHead | null> {
    const [r] = await this.#all(
      `SELECT s.id, s.title, s.global_rank, s.purpose, s.summary, s.pov_entity_id, s.pov_mode,
              s.tense, s.location_entity_id, s.word_count, s.content_text,
              s.chapter_id, c.book_id, b.sort_key, b.project_id
       FROM scene s
       JOIN chapter c ON c.id = s.chapter_id
       JOIN book b    ON b.id = c.book_id
       WHERE s.id = ? AND s.deleted_at IS NULL`, [sceneId]);
    if (!r) return null;
    return {
      id: r[0] as string, title: r[1] as string | null, globalRank: r[2] as string,
      purpose: r[3] as string | null, summary: r[4] as string | null,
      povEntityId: r[5] as string | null, povMode: r[6] as string | null,
      tense: r[7] as string | null, locationEntityId: r[8] as string | null,
      wordCount: Number(r[9] ?? 0), contentText: r[10] as string | null,
      chapterId: r[11] as string, bookId: r[12] as string,
      bookKey: r[13] as string, projectId: r[14] as string,
    };
  }

  async #entities(projectId: string): Promise<Map<string, EntityRow>> {
    const rows = await this.#all(
      `SELECT id, name, type_key, importance, summary, description
       FROM entity WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return new Map(rows.map((r) => [r[0] as string, {
      id: r[0] as string, name: r[1] as string, typeKey: r[2] as string,
      importance: (r[3] as string | null) ?? 'minor',
      summary: r[4] as string | null, description: r[5] as string | null,
    }]));
  }

  async #mentions(sceneId: string): Promise<MentionRow[]> {
    const rows = await this.#all(
      'SELECT entity_id, role, alias_used FROM mention WHERE scene_id = ?', [sceneId]);
    return rows.map((r) => ({
      entityId: r[0] as string, role: r[1] as string, aliasUsed: r[2] as string | null,
    }));
  }

  async #beats(sceneId: string): Promise<BeatRow[]> {
    const rows = await this.#all(
      `SELECT b.id, b.title, b.summary, b.function, b.tension, bs.role, a.id, a.name, a.kind
       FROM beat_scene bs
       JOIN beat b ON b.id = bs.beat_id AND b.deleted_at IS NULL
       JOIN arc a  ON a.id = b.arc_id AND a.deleted_at IS NULL
       WHERE bs.scene_id = ? ORDER BY a.sort_key, b.sort_key`, [sceneId]);
    return rows.map((r) => ({
      beatId: r[0] as string, title: r[1] as string, summary: r[2] as string | null,
      function: r[3] as string | null, tension: r[4] === null ? null : Number(r[4]),
      role: (r[5] as string | null) ?? 'develop',
      arcId: r[6] as string, arcName: r[7] as string, arcKind: r[8] as string,
    }));
  }

  async #relationships(projectId: string): Promise<RelationshipRow[]> {
    const rows = await this.#all(
      `SELECT r.from_entity_id, r.to_entity_id, r.kind, r.label, r.strength, r.is_secret,
              ss.global_rank, us.global_rank
       FROM entity_relationship r
       LEFT JOIN scene ss ON ss.id = r.since_scene_id
       LEFT JOIN scene us ON us.id = r.until_scene_id
       WHERE r.project_id = ? AND r.deleted_at IS NULL`, [projectId]);
    return rows.map((r) => ({
      fromEntityId: r[0] as string, toEntityId: r[1] as string, kind: r[2] as string,
      label: r[3] as string | null, strength: r[4] === null ? null : Number(r[4]),
      isSecret: Number(r[5]) !== 0,
      sinceRank: r[6] as string | null, untilRank: r[7] as string | null,
    }));
  }

  async #facts(projectId: string): Promise<FactRow[]> {
    const [rows, knowledge] = await Promise.all([
      this.#all(
        `SELECT f.id, f.subject_entity_id, f.object_entity_id, f.predicate, f.statement,
                f.certainty, f.spoiler_weight, f.is_dramatic_irony,
                es.global_rank, rs.global_rank, vs.global_rank, f.supersedes_fact_id
         FROM fact f
         LEFT JOIN scene es ON es.id = f.established_at_scene_id
         LEFT JOIN scene rs ON rs.id = f.revealed_at_scene_id
         LEFT JOIN scene vs ON vs.id = f.invalidated_at_scene_id
         WHERE f.project_id = ? AND f.deleted_at IS NULL`, [projectId]),
      this.#all(
        `SELECT k.fact_id, k.entity_id, k.belief, s.global_rank
         FROM fact_knowledge k
         JOIN fact f ON f.id = k.fact_id
         LEFT JOIN scene s ON s.id = k.known_from_scene_id
         WHERE f.project_id = ? AND f.deleted_at IS NULL`, [projectId]),
    ]);
    const knows = new Map<string, NonNullable<FactRow['knowledge']>[number][]>();
    for (const k of knowledge) {
      const row = { entityId: k[1] as string, belief: k[2] as string, knownFromRank: k[3] as string | null };
      knows.set(k[0] as string, [...(knows.get(k[0] as string) ?? []), row]);
    }
    return rows.map((r) => ({
      id: r[0] as string, subjectEntityId: r[1] as string | null,
      objectEntityId: r[2] as string | null, predicate: r[3] as string,
      statement: r[4] as string, certainty: (r[5] as string | null) ?? 'canon',
      spoilerWeight: Number(r[6] ?? 0), isDramaticIrony: Number(r[7]) !== 0,
      establishedRank: r[8] as string | null, revealedRank: r[9] as string | null,
      invalidatedRank: r[10] as string | null, supersedesFactId: r[11] as string | null,
      knowledge: knows.get(r[0] as string) ?? [],
    }));
  }

  async #aliases(projectId: string): Promise<AliasRow[]> {
    const rows = await this.#all(
      `SELECT a.entity_id, a.alias, a.kind, s.global_rank
       FROM entity_alias a
       JOIN entity e ON e.id = a.entity_id
       LEFT JOIN scene s ON s.id = a.linkable_from_scene_id
       WHERE e.project_id = ? AND e.deleted_at IS NULL`, [projectId]);
    return rows.map((r) => ({
      entityId: r[0] as string, alias: r[1] as string, kind: r[2] as string | null,
      linkableFromRank: r[3] as string | null,
    }));
  }

  async #laws(projectId: string): Promise<LawRow[]> {
    const rows = await this.#all(
      `SELECT id, scope_type, scope_id, category, severity, title, rule_text,
              examples_good, examples_bad, is_system, active, sort_key, check_mode, check_config
       FROM law WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return rows.map((r) => ({
      id: r[0] as string, scopeType: r[1] as LawScope, scopeId: r[2] as string | null,
      category: r[3] as string, severity: r[4] as string, title: r[5] as string,
      ruleText: r[6] as string, examplesGood: r[7] as string | null,
      examplesBad: r[8] as string | null, isSystem: Number(r[9]) !== 0,
      active: Number(r[10]) !== 0, sortKey: r[11] as string | null,
      checkMode: r[12] as string | null, checkConfig: r[13] as string | null,
    }));
  }

  /**
   * The book's shape, with chapter and part ranks composed the same way as
   * `scene.global_rank` and the lower segments left off — so they are literal
   * prefixes of the scene ranks beneath them and compare directly.
   */
  async #structure(bookId: string, bookKey: string): Promise<{
    scenes: LadderScene[]; chapters: LadderChapter[]; parts: LadderPart[];
  }> {
    const [scenes, chapters, parts] = await Promise.all([
      this.#all(
        `SELECT s.id, s.global_rank, s.chapter_id, s.title, s.summary, s.content_text
         FROM scene s JOIN chapter c ON c.id = s.chapter_id
         WHERE c.book_id = ? AND s.deleted_at IS NULL AND c.deleted_at IS NULL`, [bookId]),
      this.#all(
        `SELECT c.id, c.part_id, c.number, c.title, c.summary, c.sort_key, p.sort_key
         FROM chapter c LEFT JOIN part p ON p.id = c.part_id
         WHERE c.book_id = ? AND c.deleted_at IS NULL`, [bookId]),
      this.#all(
        'SELECT id, title, summary, sort_key FROM part WHERE book_id = ? AND deleted_at IS NULL',
        [bookId]),
    ]);
    return {
      scenes: scenes.map((r) => ({
        id: r[0] as string, globalRank: r[1] as string, chapterId: r[2] as string,
        title: r[3] as string | null, summary: r[4] as string | null, text: r[5] as string | null,
      })),
      chapters: chapters.map((r) => ({
        id: r[0] as string, partId: r[1] as string | null,
        rank: globalRank([bookKey, (r[6] as string | null) ?? '', r[5] as string]),
        number: r[2] === null ? null : Number(r[2]),
        title: r[3] as string | null, summary: r[4] as string | null,
      })),
      parts: parts.map((r) => ({
        id: r[0] as string, rank: globalRank([bookKey, r[3] as string]),
        title: r[1] as string | null, summary: r[2] as string | null,
      })),
    };
  }

  /**
   * Step 7's candidates, from the two FTS indexes with bm25 — the retriever
   * until an embedding model exists. bm25 is lower-is-better and `Candidate`
   * wants the reverse, so the score is negated; it is only ever compared within
   * one call.
   */
  async #candidates(
    projectId: string, atRank: string, povEntityId: string | null,
    briefed: ReturnType<typeof attachFacts>, factRows: readonly FactRow[],
    entities: ReadonlyMap<string, EntityRow>,
  ): Promise<Candidate[]> {
    // Any-of, not all-of: a seed of forty words matches nothing under AND.
    const expression = ftsAnyOf(supplementQuery(briefed));
    if (!expression) return [];

    const allowed = factVisibilityAt(factRows.map(toVisibility), atRank, { povEntityId });
    const factById = new Map(factRows.map((f) => [f.id, f]));

    const [sceneHits, codexHits] = await Promise.all([
      this.#all(
        `SELECT s.id, s.title, s.summary, s.global_rank, ${SCENE_RANK}
         FROM scene_fts
         JOIN scene s   ON s.id = scene_fts.scene_id
         JOIN chapter c ON c.id = s.chapter_id
         JOIN book b    ON b.id = c.book_id
         WHERE scene_fts MATCH ? AND b.project_id = ? AND s.deleted_at IS NULL
         ORDER BY ${SCENE_RANK} LIMIT ${CANDIDATES}`, [expression, projectId]),
      this.#all(
        `SELECT codex_fts.owner_table, codex_fts.owner_id, codex_fts.name, ${CODEX_RANK}
         FROM codex_fts
         WHERE codex_fts MATCH ?
           AND ((codex_fts.owner_table = 'entity' AND codex_fts.owner_id IN
                   (SELECT id FROM entity WHERE project_id = ? AND deleted_at IS NULL))
             OR (codex_fts.owner_table = 'fact' AND codex_fts.owner_id IN
                   (SELECT id FROM fact WHERE project_id = ? AND deleted_at IS NULL))
             OR (codex_fts.owner_table = 'note' AND codex_fts.owner_id IN
                   (SELECT id FROM note WHERE project_id = ? AND deleted_at IS NULL)))
         ORDER BY ${CODEX_RANK} LIMIT ${CANDIDATES}`,
        [expression, projectId, projectId, projectId]),
    ]);

    const out: Candidate[] = [];
    for (const r of sceneHits) {
      // Doc 03 searches scene *summaries*; a scene with none has nothing to add.
      const summary = (r[2] as string | null)?.trim();
      if (!summary) continue;
      out.push({
        ownerTable: 'scene', ownerId: r[0] as string, readerRank: r[3] as string,
        band: 'canon', score: -Number(r[4]), title: r[1] as string | null, text: summary,
      });
    }

    const noteIds = codexHits.filter((r) => r[0] === 'note').map((r) => r[1] as string);
    const notes = noteIds.length
      ? new Map((await this.#all(
        `SELECT id, title, body FROM note WHERE id IN (${noteIds.map(() => '?').join(',')})`,
        noteIds)).map((r) => [r[0] as string, { title: r[1] as string | null, body: r[2] as string | null }]))
      : new Map<string, { title: string | null; body: string | null }>();

    for (const r of codexHits) {
      const owner = r[0] as string;
      const id = r[1] as string;
      const score = -Number(r[3]);
      if (owner === 'fact') {
        const f = factById.get(id);
        if (!f || !allowed.get(id)?.include) continue;
        out.push({
          ownerTable: 'fact', ownerId: id, readerRank: f.revealedRank, band: 'canon',
          score, title: null, text: f.statement,
        });
      } else if (owner === 'entity') {
        const e = entities.get(id);
        const text = e?.summary?.trim() || e?.description?.trim();
        if (!e || !text) continue;
        out.push({
          ownerTable: 'entity', ownerId: id, readerRank: null, band: 'canon',
          score, title: e.name, text,
        });
      } else if (owner === 'note') {
        const n = notes.get(id);
        const text = n?.body?.trim();
        if (!text) continue;
        out.push({
          ownerTable: 'note', ownerId: id, readerRank: null, band: 'canon',
          score, title: n?.title ?? null, text,
        });
      }
    }
    return out;
  }
}

/** A `FactRow` in the shape the visibility rule takes, knowledge folded. */
function toVisibility(f: FactRow): FactForVisibility {
  const knownFrom: Record<string, string | null> = {};
  for (const k of f.knowledge ?? []) if (isKnowing(k.belief)) knownFrom[k.entityId] = k.knownFromRank;
  return {
    id: f.id, establishedRank: f.establishedRank, revealedRank: f.revealedRank,
    invalidatedRank: f.invalidatedRank, supersedesFactId: f.supersedesFactId,
    isDramaticIrony: f.isDramaticIrony, spoilerWeight: f.spoilerWeight, knownFrom,
  };
}

/**
 * Step 5's voice notes: `voice` laws scoped to an entity, for everybody, and
 * `pov`-scoped ones only for the character who holds the point of view here.
 * Step 8 leaves both kinds out, as its header promises.
 */
function voiceNotesFrom(laws: readonly LawRow[], povEntityId: string | null): VoiceNote[] {
  return laws
    .filter((l) => l.active && l.category === 'voice' && l.scopeId !== null)
    .filter((l) => l.scopeType === 'entity' || (l.scopeType === 'pov' && l.scopeId === povEntityId))
    .map((l) => ({
      entityId: l.scopeId as string, title: l.title, ruleText: l.ruleText, severity: l.severity,
    }));
}
