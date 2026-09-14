import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import { codexFtsStatements } from '../index/codexIndex';
import type { FactForVisibility } from '../domain/factVisibility';

/**
 * Facts — the temporal record of what is true, when it became true, and when
 * the reader found out.
 *
 * The three columns that matter are `established_at_scene_id`,
 * `revealed_at_scene_id` and `fact_knowledge`, and they are the reason this
 * table exists rather than a notes field. A fact is not just a claim; it is a
 * claim with a position in the book and an audience. The rule that reads them
 * lives in `src/domain/factVisibility.ts`, deliberately outside any query, so
 * the scene brief compiler and this UI cannot drift into two different answers
 * about what a reader knows.
 *
 * Scene positions are carried as `global_rank`, never as ids, because rank is
 * what compares — and because a scene dragged in the tree changes its rank and
 * every fact's position moves with it, with nothing here needing to know.
 */

export type Certainty = 'canon' | 'planned' | 'speculative';
export type Belief = 'knows' | 'suspects' | 'believes_false' | 'denies';

export interface Fact extends FactForVisibility {
  id: string;
  projectId: string;
  subjectEntityId: string | null;
  subjectName: string | null;
  predicate: string;
  objectText: string | null;
  statement: string;
  establishedSceneId: string | null;
  revealedSceneId: string | null;
  invalidatedSceneId: string | null;
  certainty: Certainty;
  source: string;
  confirmed: boolean;
  rev: number;
}

export interface KnowledgeRow {
  id: string;
  factId: string;
  entityId: string;
  entityName: string;
  belief: Belief;
  knownFromSceneId: string | null;
  knownFromRank: string | null;
  learnedHow: string | null;
}

export interface FactConflict {
  factA: string;
  factB: string;
  subjectEntityId: string | null;
  predicate: string;
}

export interface FactDraft {
  subjectEntityId?: string | null;
  predicate: string;
  objectText?: string | null;
  statement?: string;
  establishedSceneId?: string | null;
  revealedSceneId?: string | null;
  invalidatedSceneId?: string | null;
  certainty?: Certainty;
  spoilerWeight?: number;
  isDramaticIrony?: boolean;
}

interface Statement { sql: string; params: unknown[] }

/**
 * A readable sentence from the structured parts.
 *
 * The schema calls `statement` "rendered for prompts & UI", so something has to
 * render it. Composing it here means a writer who fills in the fields gets a
 * usable sentence without writing it twice — and because it is stored rather
 * than derived on read, editing it afterwards keeps the edit.
 */
export function composeStatement(
  subjectName: string | null, predicate: string, objectText: string | null,
): string {
  return [subjectName, predicate, objectText].filter(Boolean).join(' ').trim()
    || predicate.trim();
}

const FACT_COLUMNS = `f.id, f.project_id, f.subject_entity_id, e.name, f.predicate,
  f.object_text, f.statement,
  f.established_at_scene_id, f.revealed_at_scene_id, f.invalidated_at_scene_id,
  es.global_rank, rs.global_rank, ivs.global_rank,
  f.supersedes_fact_id, f.certainty, f.spoiler_weight, f.is_dramatic_irony,
  f.source, f.confirmed, f.rev`;

const FACT_FROM = `FROM fact f
  LEFT JOIN entity e  ON e.id  = f.subject_entity_id
  LEFT JOIN scene es  ON es.id = f.established_at_scene_id
  LEFT JOIN scene rs  ON rs.id = f.revealed_at_scene_id
  LEFT JOIN scene ivs ON ivs.id = f.invalidated_at_scene_id`;

export class FactsRepository {
  constructor(private readonly driver: SqlDriver) {}

  /* ------------------------------------------------------------------ reads */

  async listFacts(
    projectId: string, filter: { subjectEntityId?: string } = {},
  ): Promise<Fact[]> {
    const where = ['f.project_id = ?', 'f.deleted_at IS NULL'];
    const params: unknown[] = [projectId];
    if (filter.subjectEntityId) {
      where.push('f.subject_entity_id = ?');
      params.push(filter.subjectEntityId);
    }
    const { rows } = await this.driver.query(
      `SELECT ${FACT_COLUMNS} ${FACT_FROM}
       WHERE ${where.join(' AND ')}
       ORDER BY e.name COLLATE NOCASE, f.predicate`, params, 'all');

    const facts = (rows as unknown[][]).map(toFact);
    // One query for all of them rather than one per fact: a codex of any size
    // would otherwise make this list quadratic in round trips.
    const knowledge = await this.knowledgeFor(facts.map((f) => f.id));
    for (const fact of facts) {
      const rows2 = knowledge.get(fact.id);
      if (rows2?.length) {
        fact.knownFrom = Object.fromEntries(rows2
          // `believes_false` and `denies` are not knowledge. Counting them
          // would let the spoiler rule reveal a fact to a character who has
          // been lied to about it.
          .filter((k) => k.belief === 'knows' || k.belief === 'suspects')
          .map((k) => [k.entityId, k.knownFromRank]));
      }
    }
    return facts;
  }

  async knowledgeFor(factIds: readonly string[]): Promise<Map<string, KnowledgeRow[]>> {
    const out = new Map<string, KnowledgeRow[]>();
    if (!factIds.length) return out;
    const holes = factIds.map(() => '?').join(',');
    const { rows } = await this.driver.query(
      `SELECT k.id, k.fact_id, k.entity_id, e.name, k.belief,
              k.known_from_scene_id, s.global_rank, k.learned_how
       FROM fact_knowledge k
       JOIN entity e ON e.id = k.entity_id
       LEFT JOIN scene s ON s.id = k.known_from_scene_id
       WHERE k.fact_id IN (${holes}) AND e.deleted_at IS NULL
       ORDER BY e.name COLLATE NOCASE`, [...factIds], 'all');

    for (const r of rows as unknown[][]) {
      const row: KnowledgeRow = {
        id: r[0] as string, factId: r[1] as string, entityId: r[2] as string,
        entityName: r[3] as string, belief: r[4] as Belief,
        knownFromSceneId: r[5] as string | null, knownFromRank: r[6] as string | null,
        learnedHow: r[7] as string | null,
      };
      const at = out.get(row.factId);
      if (at) at.push(row);
      else out.set(row.factId, [row]);
    }
    return out;
  }

  /**
   * Contradictions, from the view that knows how to spot them.
   *
   * Two active facts about the same subject and predicate whose objects differ.
   * The view returned the empty set for every input until migration 003 — an
   * `AND` that should have been an `OR` — which is the worst way for a check to
   * fail, because "no contradictions" is exactly what a working one says most
   * of the time.
   */
  async conflicts(projectId: string): Promise<FactConflict[]> {
    const { rows } = await this.driver.query(
      `SELECT c.fact_a, c.fact_b, c.subject_entity_id, c.predicate
       FROM v_fact_conflicts c
       JOIN fact a ON a.id = c.fact_a
       WHERE a.project_id = ?`, [projectId], 'all');
    return (rows as unknown[][]).map((r) => ({
      factA: r[0] as string, factB: r[1] as string,
      subjectEntityId: r[2] as string | null, predicate: r[3] as string,
    }));
  }

  /* ----------------------------------------------------------------- writes */

  async createFact(projectId: string, draft: FactDraft): Promise<string> {
    const now = Date.now();
    const id = uuidv7(now);
    const subjectName = draft.subjectEntityId
      ? await this.#entityName(draft.subjectEntityId)
      : null;
    const statement = draft.statement?.trim()
      || composeStatement(subjectName, draft.predicate, draft.objectText ?? null);

    await this.driver.batch([
      {
        sql: `INSERT INTO fact (id,project_id,subject_entity_id,predicate,object_text,statement,
                established_at_scene_id,revealed_at_scene_id,invalidated_at_scene_id,
                certainty,spoiler_weight,is_dramatic_irony,source,confirmed,
                created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'manual',1,?,?,1)`,
        params: [id, projectId, draft.subjectEntityId ?? null, draft.predicate,
          draft.objectText ?? null, statement,
          draft.establishedSceneId ?? null, draft.revealedSceneId ?? null,
          draft.invalidatedSceneId ?? null,
          draft.certainty ?? 'canon', draft.spoilerWeight ?? 0,
          draft.isDramaticIrony ? 1 : 0, now, now],
      },
      this.#op('fact', id, 'insert', { ...draft, statement }, now),
      // Searchable immediately, not after a rebuild. The codex learned this
      // lesson already; there is no reason for facts to learn it again.
      ...codexFtsStatements('fact', id),
    ], true);
    return id;
  }

  async updateFact(id: string, patch: Partial<FactDraft>): Promise<void> {
    const now = Date.now();
    const columns: Record<string, unknown> = {};
    const set = (column: string, value: unknown) => { columns[column] = value; };
    if (patch.subjectEntityId !== undefined) set('subject_entity_id', patch.subjectEntityId);
    if (patch.predicate !== undefined) set('predicate', patch.predicate);
    if (patch.objectText !== undefined) set('object_text', patch.objectText);
    if (patch.statement !== undefined) set('statement', patch.statement);
    if (patch.establishedSceneId !== undefined) {
      set('established_at_scene_id', patch.establishedSceneId);
    }
    if (patch.revealedSceneId !== undefined) set('revealed_at_scene_id', patch.revealedSceneId);
    if (patch.invalidatedSceneId !== undefined) {
      set('invalidated_at_scene_id', patch.invalidatedSceneId);
    }
    if (patch.certainty !== undefined) set('certainty', patch.certainty);
    if (patch.spoilerWeight !== undefined) set('spoiler_weight', patch.spoilerWeight);
    if (patch.isDramaticIrony !== undefined) {
      set('is_dramatic_irony', patch.isDramaticIrony ? 1 : 0);
    }
    if (!Object.keys(columns).length) return;

    await this.driver.batch([
      {
        sql: `UPDATE fact SET ${Object.keys(columns).map((c) => `${c} = ?`).join(', ')},
                updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [...Object.values(columns), now, id],
      },
      this.#op('fact', id, 'update', patch, now),
      ...codexFtsStatements('fact', id),
    ], true);
  }

  async removeFact(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE fact SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('fact', id, 'delete', null, now),
      // The INSERT half finds no undeleted row, so this takes it out of search.
      ...codexFtsStatements('fact', id),
    ], true);
  }

  /* -------------------------------------------------------------- knowledge */

  /**
   * Record that someone knows — or has been lied to about — a fact.
   *
   * Upserts on (fact, entity): the schema has a unique index on the pair, and a
   * character's belief changing is an edit rather than a second opinion.
   */
  async setKnowledge(
    factId: string, entityId: string,
    options: { belief?: Belief; knownFromSceneId?: string | null; learnedHow?: string } = {},
  ): Promise<void> {
    const now = Date.now();
    const belief = options.belief ?? 'knows';
    await this.driver.batch([
      {
        sql: `INSERT INTO fact_knowledge (id,fact_id,entity_id,belief,known_from_scene_id,
                learned_how,created_at)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(fact_id, entity_id) DO UPDATE SET
                belief = excluded.belief,
                known_from_scene_id = excluded.known_from_scene_id,
                learned_how = excluded.learned_how`,
        params: [uuidv7(now), factId, entityId, belief,
          options.knownFromSceneId ?? null, options.learnedHow ?? null, now],
      },
      this.#op('fact_knowledge', `${factId}:${entityId}`, 'update', { belief }, now),
    ], true);
  }

  async removeKnowledge(factId: string, entityId: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: 'DELETE FROM fact_knowledge WHERE fact_id = ? AND entity_id = ?',
        params: [factId, entityId],
      },
      this.#op('fact_knowledge', `${factId}:${entityId}`, 'delete', null, now),
    ], true);
  }

  /* ----------------------------------------------------------------- private */

  async #entityName(id: string): Promise<string | null> {
    const { rows } = await this.driver.query('SELECT name FROM entity WHERE id = ?', [id], 'get');
    return ((rows as unknown[])[0] as string | undefined) ?? null;
  }

  #op(table: string, rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), table, rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}

function toFact(r: unknown[]): Fact {
  return {
    id: r[0] as string,
    projectId: r[1] as string,
    subjectEntityId: r[2] as string | null,
    subjectName: r[3] as string | null,
    predicate: r[4] as string,
    objectText: r[5] as string | null,
    statement: r[6] as string,
    establishedSceneId: r[7] as string | null,
    revealedSceneId: r[8] as string | null,
    invalidatedSceneId: r[9] as string | null,
    establishedRank: r[10] as string | null,
    revealedRank: r[11] as string | null,
    invalidatedRank: r[12] as string | null,
    supersedesFactId: r[13] as string | null,
    certainty: ((r[14] as string | null) ?? 'canon') as Certainty,
    spoilerWeight: Number(r[15] ?? 0),
    isDramaticIrony: Number(r[16]) !== 0,
    source: (r[17] as string | null) ?? 'manual',
    confirmed: Number(r[18]) !== 0,
    rev: Number(r[19]),
  };
}
