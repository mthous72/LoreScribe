import type { SqlDriver } from '../db/driver';

/**
 * `index_state` — the row that makes derived data admit it is derived.
 *
 * Four things in this schema are computed, not authored: `mention`,
 * `scene_fts`/`codex_fts`, `embedding` and `scene.global_rank`
 * ([doc 02 §9b](../../docs/02-data-model.md)). They sit in the same file as the
 * novel and look exactly like it, so without this table nothing can say "these
 * rows were built by an older matcher and are wrong now."
 *
 * The mechanism is an **algorithm revision** per kind. Change the alias
 * matcher, bump `REVISIONS.mention`; every row built by the old one is stale by
 * definition, and a rebuild is a settings button rather than a support
 * incident.
 *
 * The write order matters and is the whole safety argument: a kind is marked
 * stale *before* its rebuild starts and cleared only when the rebuild finishes.
 * A tab that dies mid-rebuild therefore leaves `stale = 1`, and the next
 * session rebuilds instead of trusting a half-built index. The failure mode of
 * getting this backwards is silent and permanent, which is why it is not left
 * to the caller to remember.
 */

export type DerivedKind = 'mention' | 'fts' | 'embedding' | 'rank';

export const DERIVED_KINDS: readonly DerivedKind[] = ['rank', 'mention', 'fts', 'embedding'];

/**
 * Bump the entry when the algorithm that produces that kind changes.
 *
 * These are not schema versions. `user_version` says what shape the tables
 * have; this says what code filled them. The two move independently — fixing a
 * word-boundary bug in the alias matcher changes no table at all and still
 * invalidates every `mention` row in every project.
 */
export const REVISIONS: Record<DerivedKind, number> = {
  rank: 1,
  mention: 1,
  fts: 1,
  embedding: 1,
};

export interface IndexStateRow {
  kind: DerivedKind;
  /** The revision that built the rows currently in the table. */
  algoRevision: number;
  builtAt: number | null;
  builtRows: number | null;
  stale: boolean;
  lastError: string | null;
}

export interface KindStatus extends IndexStateRow {
  /** The revision the code would build with today. */
  currentRevision: number;
  needsRebuild: boolean;
  /** Why, in a sentence a writer can read. Null when nothing needs doing. */
  reason: string | null;
}

const SELECT = `SELECT kind, algo_revision, built_at, built_rows, stale, last_error
                FROM index_state`;

export async function readIndexState(driver: SqlDriver): Promise<Map<DerivedKind, IndexStateRow>> {
  const { rows } = await driver.query(SELECT, [], 'all');
  const out = new Map<DerivedKind, IndexStateRow>();
  for (const r of rows as unknown[][]) {
    out.set(r[0] as DerivedKind, {
      kind: r[0] as DerivedKind,
      algoRevision: Number(r[1]),
      builtAt: r[2] === null ? null : Number(r[2]),
      builtRows: r[3] === null ? null : Number(r[3]),
      stale: Number(r[4]) !== 0,
      lastError: (r[5] as string | null) ?? null,
    });
  }
  return out;
}

/**
 * What each kind needs, judged against the revisions this build ships.
 *
 * A kind with no row at all needs a rebuild: an absent row is not "fresh", it
 * is "never built", and the two are indistinguishable from the data itself.
 */
export async function indexStatus(driver: SqlDriver): Promise<KindStatus[]> {
  const state = await readIndexState(driver);
  return DERIVED_KINDS.map((kind) => {
    const current = REVISIONS[kind];
    const row = state.get(kind) ?? {
      kind, algoRevision: 0, builtAt: null, builtRows: null, stale: true, lastError: null,
    };
    const reason = row.lastError !== null
      ? `the last rebuild failed: ${row.lastError}`
      : row.builtAt === null
        ? 'never built'
        : row.algoRevision !== current
          ? `built by an older version of this feature (revision ${row.algoRevision}, now ${current})`
          : row.stale
            ? 'marked out of date by a change to your project'
            : null;
    return { ...row, currentRevision: current, needsRebuild: reason !== null, reason };
  });
}

/**
 * Mark kinds out of date.
 *
 * Called by anything that invalidates derived data — an import, a restore, a
 * bulk edit — and by the rebuilder itself on the way in. Best-effort by
 * design: this table describes a cache, so failing to write it must never take
 * a writer's edit down with it. That is doc 08's rule 6, and unlike `op_log`
 * it genuinely qualifies, because the state is reconstructible — the revision
 * comparison catches a missed flag on the next open.
 */
export async function markStale(driver: SqlDriver, kinds: readonly DerivedKind[]): Promise<void> {
  if (!kinds.length) return;
  try {
    await driver.batch(kinds.map((kind) => ({
      sql: `INSERT INTO index_state (kind, algo_revision, stale) VALUES (?, ?, 1)
            ON CONFLICT(kind) DO UPDATE SET stale = 1`,
      params: [kind, REVISIONS[kind]],
    })), true);
  } catch { /* a cache flag is not worth failing a write over */ }
}

export async function recordBuild(
  driver: SqlDriver, kind: DerivedKind, rows: number, at = Date.now(),
): Promise<void> {
  await driver.query(
    `INSERT INTO index_state (kind, algo_revision, built_at, built_rows, stale, last_error)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(kind) DO UPDATE SET
       algo_revision = excluded.algo_revision, built_at = excluded.built_at,
       built_rows = excluded.built_rows, stale = 0, last_error = NULL`,
    [kind, REVISIONS[kind], at, rows], 'run');
}

/**
 * Record a failed rebuild, leaving the kind stale.
 *
 * The error is kept on the row rather than only shown once, because the tab
 * that saw the toast is not necessarily the one that reopens the project.
 */
export async function recordFailure(driver: SqlDriver, kind: DerivedKind, error: unknown): Promise<void> {
  const message = (error as { message?: string })?.message ?? String(error);
  try {
    await driver.query(
      `INSERT INTO index_state (kind, algo_revision, stale, last_error) VALUES (?, ?, 1, ?)
       ON CONFLICT(kind) DO UPDATE SET stale = 1, last_error = excluded.last_error`,
      [kind, REVISIONS[kind], message.slice(0, 500)], 'run');
  } catch { /* already failing; do not fail harder */ }
}
