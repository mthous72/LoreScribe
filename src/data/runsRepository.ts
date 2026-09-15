import type { SqlDriver } from '../db/driver';
import { uuidv7 } from './ids';

/**
 * `ai_run` — every call, with the brief it was made from.
 *
 * Doc 06: *each step is a separate `ai_run` row with its own brief and cost*,
 * and the brief is stored verbatim rather than only the prompt string, because
 * a run that is backgrounded mid-stream is resumed from its stored brief. It
 * is also the audit: what the model was shown, what came back, who served it,
 * what it cost. `params_json` never carries a key ([D30](../../docs/10-decisions.md)).
 *
 * Writes here are best-effort in the sense of doc 08's rule 6 — telemetry must
 * never break generation — but the row is opened *before* the call and closed
 * after it, so a call that dies mid-way leaves a row that says so rather than
 * nothing.
 */

export type RunStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'refused' | 'truncated' | 'blocked';

export interface AiRun {
  id: string;
  projectId: string;
  sceneId: string | null;
  purpose: string;
  provider: string | null;
  model: string | null;
  outputText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: RunStatus | null;
  servedBy: string | null;
  errorText: string | null;
  blockReason: string | null;
  accepted: boolean;
  createdAt: number;
}

export interface RunStart {
  sceneId: string | null;
  purpose: string;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  briefJson: string;
  promptRendered: string;
}

/** A run the app refused to make. Nothing was sent; the row is the record that it was asked for. */
export interface RunBlock {
  sceneId: string | null;
  purpose: string;
  provider: string | null;
  model: string | null;
  reason: string;
}

export interface RunFinish {
  outputText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  costUsd: number | null;
  latencyMs: number;
  status: RunStatus;
  servedBy: string | null;
  errorText?: string | null;
  sanitizerActions?: unknown;
}

const COLUMNS = `id, project_id, scene_id, purpose, provider, model, output_text, tokens_in, tokens_out,
  tokens_reasoning, cost_usd, latency_ms, status, served_by, error_text, accepted, created_at, block_reason`;

const toRun = (r: unknown[]): AiRun => ({
  id: r[0] as string, projectId: r[1] as string, sceneId: r[2] as string | null,
  purpose: r[3] as string, provider: r[4] as string | null, model: r[5] as string | null,
  outputText: r[6] as string | null,
  tokensIn: r[7] === null ? null : Number(r[7]), tokensOut: r[8] === null ? null : Number(r[8]),
  tokensReasoning: r[9] === null ? null : Number(r[9]), costUsd: r[10] === null ? null : Number(r[10]),
  latencyMs: r[11] === null ? null : Number(r[11]), status: r[12] as RunStatus | null,
  servedBy: r[13] as string | null, errorText: r[14] as string | null,
  accepted: Number(r[15]) !== 0, createdAt: Number(r[16]), blockReason: r[17] as string | null,
});

export class RunsRepository {
  constructor(private readonly driver: SqlDriver) {}

  async start(projectId: string, run: RunStart): Promise<string> {
    const now = Date.now();
    const id = uuidv7(now);
    await this.driver.query(
      `INSERT INTO ai_run (id, project_id, scene_id, purpose, provider, model, params_json, brief_json,
                           prompt_rendered, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [id, projectId, run.sceneId, run.purpose, run.provider, run.model, JSON.stringify(run.params),
        run.briefJson, run.promptRendered, now], 'run');
    return id;
  }

  /**
   * Record a run stopped BEFORE the call — the schema's `blocked`. Cost is
   * null, so it never counts toward the spend it was blocked for.
   */
  async block(projectId: string, run: RunBlock): Promise<string> {
    const now = Date.now();
    const id = uuidv7(now);
    await this.driver.query(
      `INSERT INTO ai_run (id, project_id, scene_id, purpose, provider, model, status, block_reason, latency_ms,
                           created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, 0, ?)`,
      [id, projectId, run.sceneId, run.purpose, run.provider, run.model, run.reason, now], 'run');
    return id;
  }

  async finish(id: string, done: RunFinish): Promise<void> {
    await this.driver.query(
      `UPDATE ai_run SET output_text = ?, tokens_in = ?, tokens_out = ?, tokens_reasoning = ?, cost_usd = ?,
                         latency_ms = ?, status = ?, served_by = ?, error_text = ?, sanitizer_actions = ?
       WHERE id = ?`,
      [done.outputText, done.tokensIn, done.tokensOut, done.tokensReasoning, done.costUsd, done.latencyMs,
        done.status, done.servedBy, done.errorText ?? null,
        done.sanitizerActions === undefined ? null : JSON.stringify(done.sanitizerActions), id], 'run');
  }

  async accept(id: string): Promise<void> {
    await this.driver.query('UPDATE ai_run SET accepted = 1 WHERE id = ?', [id], 'run');
  }

  async get(id: string): Promise<AiRun | null> {
    const { rows } = await this.driver.query(`SELECT ${COLUMNS} FROM ai_run WHERE id = ?`, [id], 'all');
    const r = (rows as unknown[][])[0];
    return r ? toRun(r) : null;
  }

  async list(projectId: string, sceneId?: string): Promise<AiRun[]> {
    const { rows } = await this.driver.query(
      `SELECT ${COLUMNS} FROM ai_run WHERE project_id = ? ${sceneId ? 'AND scene_id = ?' : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT 50`,
      sceneId ? [projectId, sceneId] : [projectId], 'all');
    return (rows as unknown[][]).map(toRun);
  }

  /** What the project has spent, in USD, since a moment — for the meter D17 asks for. */
  async spentSince(projectId: string, since: number): Promise<number> {
    const { rows } = await this.driver.query(
      'SELECT COALESCE(SUM(cost_usd), 0) FROM ai_run WHERE project_id = ? AND created_at >= ?',
      [projectId, since], 'all');
    return Number((rows as unknown[][])[0]?.[0] ?? 0);
  }

  /**
   * Runs since a moment that used tokens but carry no cost, because the profile
   * had no prices. They are missing from `spentSince`, and the meter says so
   * rather than showing a sum that looks complete.
   */
  async unpricedSince(projectId: string, since: number): Promise<number> {
    const { rows } = await this.driver.query(
      `SELECT COUNT(*) FROM ai_run WHERE project_id = ? AND created_at >= ? AND cost_usd IS NULL
         AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)`,
      [projectId, since], 'all');
    return Number((rows as unknown[][])[0]?.[0] ?? 0);
  }
}
