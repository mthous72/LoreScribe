import type { SqlDriver } from '../db/driver';
import { uuidv7 } from './ids';
import type { Finding } from '../domain/verify';

/**
 * `law_violation` — what the verification phase found, per run.
 *
 * Doc 04: violations are written here and rendered against the prose with the
 * law, the reason and a suggested fix; the writer fixes, dismisses, or amends
 * the law. `evidence_verified` is the schema's own word for
 * [doc 12 §3](../../docs/12-algorithms.md): a rubric claim whose quote is not
 * in the prose is stored with it false, shown as uncertain, and never counted
 * as a finding.
 *
 * Findings are keyed to the run, not the scene's live text: offsets are into
 * the run's output, which the writer may or may not accept.
 */

export type Resolution = 'pending' | 'fixed' | 'dismissed' | 'law_amended';

export interface ViolationRow {
  id: string;
  runId: string | null;
  sceneId: string | null;
  lawId: string;
  severity: string | null;
  quote: string | null;
  start: number | null;
  end: number | null;
  evidenceVerified: boolean;
  explanation: string | null;
  suggestedFix: string | null;
  resolution: Resolution;
  createdAt: number;
}

const COLUMNS = `id, ai_run_id, scene_id, law_id, severity, quote, start_offset, end_offset, evidence_verified,
  explanation, suggested_fix, resolution, created_at`;

const toRow = (r: unknown[]): ViolationRow => ({
  id: r[0] as string, runId: r[1] as string | null, sceneId: r[2] as string | null, lawId: r[3] as string,
  severity: r[4] as string | null, quote: r[5] as string | null,
  start: r[6] === null ? null : Number(r[6]), end: r[7] === null ? null : Number(r[7]),
  evidenceVerified: Number(r[8]) !== 0, explanation: r[9] as string | null,
  suggestedFix: r[10] as string | null, resolution: (r[11] as Resolution | null) ?? 'pending',
  createdAt: Number(r[12]),
});

export class ViolationsRepository {
  constructor(private readonly driver: SqlDriver) {}

  /** Store a run's findings, uncertain ones included, in one transaction. */
  async record(runId: string, sceneId: string | null, findings: readonly Finding[]): Promise<string[]> {
    if (findings.length === 0) return [];
    const now = Date.now();
    const ids: string[] = [];
    await this.driver.batch(findings.map((f, i) => {
      const id = uuidv7(now + i);
      ids.push(id);
      return {
        sql: `INSERT INTO law_violation (id, ai_run_id, scene_id, law_id, severity, quote, start_offset, end_offset,
                                         evidence_verified, explanation, suggested_fix, resolution, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        params: [id, runId, sceneId, f.lawId, f.severity, f.quote, f.start, f.end, Number(f.evidenceVerified),
          f.explanation, f.suggestedFix, now],
      };
    }));
    return ids;
  }

  async listForRun(runId: string): Promise<ViolationRow[]> {
    const { rows } = await this.driver.query(
      `SELECT ${COLUMNS} FROM law_violation WHERE ai_run_id = ? ORDER BY start_offset IS NULL, start_offset, created_at`,
      [runId], 'all');
    return (rows as unknown[][]).map(toRow);
  }

  async resolve(id: string, resolution: Resolution): Promise<void> {
    await this.driver.query('UPDATE law_violation SET resolution = ? WHERE id = ?', [resolution, id], 'run');
  }
}
