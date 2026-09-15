import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';

/**
 * Laws — the rules the model must follow, as rows a writer can edit.
 *
 * Doc 04: a law is a *scoped, typed, checkable constraint*. The compiler has
 * read them since step 8 and the importer has written them since the plan came
 * in; this is the first thing that lets a writer see one after the fact and
 * change it, which doc 04 says matters more than it sounds — *a law being
 * violated constantly is often a law that's wrong, and the tool should make it
 * easy to say so*.
 *
 * System laws — the hard floor ([D3](../../docs/10-decisions.md)) — are listed
 * but refused by every write here. Not hidden: a writer should be able to read
 * what the tool will not do. Not editable: that is what "floor" means.
 */

export type LawScopeType = 'project' | 'book' | 'arc' | 'chapter' | 'scene' | 'entity' | 'pov';
export type LawCategory = 'canon' | 'style' | 'voice' | 'structure' | 'content' | 'ip';
export type LawSeverity = 'must' | 'should' | 'prefer';

export interface Law {
  id: string;
  projectId: string;
  scopeType: LawScopeType;
  scopeId: string | null;
  category: LawCategory;
  severity: LawSeverity;
  title: string;
  ruleText: string;
  rationale: string | null;
  examplesGood: string | null;
  examplesBad: string | null;
  isSystem: boolean;
  active: boolean;
  sortKey: string | null;
  rev: number;
}

export interface LawDraft {
  title: string;
  ruleText: string;
  category: LawCategory;
  severity?: LawSeverity;
  scopeType?: LawScopeType;
  scopeId?: string | null;
  rationale?: string | null;
  examplesGood?: string | null;
  examplesBad?: string | null;
}

export interface LawPatch {
  title?: string;
  ruleText?: string;
  category?: LawCategory;
  severity?: LawSeverity;
  scopeType?: LawScopeType;
  scopeId?: string | null;
  rationale?: string | null;
  examplesGood?: string | null;
  examplesBad?: string | null;
  active?: boolean;
}

const COLUMNS = `id, project_id, scope_type, scope_id, category, severity, title, rule_text,
  rationale, examples_good, examples_bad, is_system, active, sort_key, rev`;

const toLaw = (r: unknown[]): Law => ({
  id: r[0] as string, projectId: r[1] as string,
  scopeType: r[2] as LawScopeType, scopeId: r[3] as string | null,
  category: r[4] as LawCategory, severity: r[5] as LawSeverity,
  title: r[6] as string, ruleText: r[7] as string,
  rationale: r[8] as string | null, examplesGood: r[9] as string | null,
  examplesBad: r[10] as string | null, isSystem: Number(r[11]) !== 0,
  active: Number(r[12]) !== 0, sortKey: r[13] as string | null, rev: Number(r[14]),
});

const PATCH_COLUMNS: Record<keyof LawPatch, string> = {
  title: 'title', ruleText: 'rule_text', category: 'category', severity: 'severity',
  scopeType: 'scope_type', scopeId: 'scope_id', rationale: 'rationale',
  examplesGood: 'examples_good', examplesBad: 'examples_bad', active: 'active',
};

export class LawsRepository {
  constructor(private readonly driver: SqlDriver) {}

  async #all(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return (await this.driver.query(sql, params, 'all')).rows as unknown[][];
  }

  /** Every law of the project, the hard floor included, in step 8's order. */
  async list(projectId: string): Promise<Law[]> {
    const rows = await this.#all(
      `SELECT ${COLUMNS} FROM law WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY CASE severity WHEN 'must' THEN 0 WHEN 'should' THEN 1 ELSE 2 END,
                is_system DESC, sort_key, title COLLATE NOCASE`, [projectId]);
    return rows.map(toLaw);
  }

  async get(id: string): Promise<Law | null> {
    const [r] = await this.#all(`SELECT ${COLUMNS} FROM law WHERE id = ? AND deleted_at IS NULL`, [id]);
    return r ? toLaw(r) : null;
  }

  async create(projectId: string, draft: LawDraft): Promise<Law> {
    const now = Date.now();
    const law: Law = {
      id: uuidv7(now), projectId,
      scopeType: draft.scopeType ?? 'project', scopeId: draft.scopeId ?? null,
      category: draft.category, severity: draft.severity ?? 'must',
      title: draft.title.trim(), ruleText: draft.ruleText.trim(),
      rationale: draft.rationale ?? null,
      examplesGood: draft.examplesGood ?? null, examplesBad: draft.examplesBad ?? null,
      isSystem: false, active: true, sortKey: null, rev: 1,
    };
    if (!law.title || !law.ruleText) throw new Error('a law needs a title and a rule');
    await this.driver.batch([
      {
        sql: `INSERT INTO law (id, project_id, scope_type, scope_id, category, severity, title, rule_text,
                               rationale, examples_good, examples_bad, check_mode, is_system, active,
                               created_at, updated_at, rev)
              VALUES (?,?,?,?,?,?,?,?,?,?,?, 'prompt', 0, 1, ?, ?, 1)`,
        params: [law.id, projectId, law.scopeType, law.scopeId, law.category, law.severity,
          law.title, law.ruleText, law.rationale, law.examplesGood, law.examplesBad, now, now],
      },
      this.#op(law.id, 'insert', law, now),
    ], true);
    return law;
  }

  /** Change what a writer may change. Refuses the hard floor. */
  async update(id: string, patch: LawPatch): Promise<void> {
    await this.#writable(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof LawPatch, string][]) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      params.push(typeof value === 'boolean' ? Number(value)
        : typeof value === 'string' ? value.trim() : value ?? null);
    }
    if (sets.length === 0) return;
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE law SET ${sets.join(', ')}, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [...params, now, id],
      },
      this.#op(id, 'update', patch, now),
    ], true);
  }

  /** Soft delete, like everything else a writer removes. Refuses the hard floor. */
  async remove(id: string): Promise<void> {
    await this.#writable(id);
    const now = Date.now();
    await this.driver.batch([
      {
        sql: 'UPDATE law SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND deleted_at IS NULL',
        params: [now, now, id],
      },
      this.#op(id, 'delete', null, now),
    ], true);
  }

  async #writable(id: string): Promise<void> {
    const law = await this.get(id);
    if (!law) throw new Error('no such law');
    if (law.isSystem) throw new Error('the hard floor is not editable');
  }

  #op(rowId: string, op: string, payload: unknown, ts: number) {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), 'law', rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}
