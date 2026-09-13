import { useCallback, useEffect, useState } from 'react';
import { useDb } from './DbProvider';
import { rebuildAll, rebuildKind, rebuildPlan, type RebuildOutcome, type RebuildProgress } from '../index/rebuild';
import type { DerivedKind } from '../index/indexState';

type PlanRow = Awaited<ReturnType<typeof rebuildPlan>>[number];

/**
 * "A settings button, not a support incident" — [doc 02 §9b](../../docs/02-data-model.md).
 *
 * Deliberately not an automatic rebuild on open. Two reasons, and the second is
 * the one that decided it: a full rebuild on a 150,000-word project is seconds
 * of work the writer did not ask for, on a phone possibly a lot more — and a
 * rebuild that starts by itself is a rebuild nobody can decline when it is
 * going wrong. What is automatic is the *detection*: the panel says what is out
 * of date and why, in the writer's terms rather than the schema's, and then
 * waits.
 *
 * The one thing it will not do is claim something is built when it is not. A
 * kind with no rebuilder yet says so.
 */
export function IndexPanel({ projectId }: { projectId: string }) {
  const db = useDb();
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [busy, setBusy] = useState<DerivedKind | 'all' | null>(null);
  const [progress, setProgress] = useState<RebuildProgress | null>(null);
  const [outcomes, setOutcomes] = useState<RebuildOutcome[]>([]);

  const refresh = useCallback(async () => {
    if (db.state !== 'ready') return;
    setPlan(await rebuildPlan(db.driver));
  }, [db]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const next = await rebuildPlan(db.driver);
      if (!cancelled) setPlan(next);
    })();
    return () => { cancelled = true; };
  }, [db]);

  const run = async (kind: DerivedKind | 'all') => {
    if (db.state !== 'ready') return;
    setBusy(kind);
    setOutcomes([]);
    setProgress(null);
    try {
      const results = kind === 'all'
        ? await rebuildAll(db.driver, projectId, undefined, setProgress)
        : [await rebuildKind(db.driver, projectId, kind, setProgress)];
      setOutcomes(results);
      await refresh();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  if (db.state !== 'ready' || !plan) return null;
  const buildable = plan.filter((p) => !p.unavailable);
  const outOfDate = buildable.filter((p) => p.needsRebuild);

  return (
    <section className="mt-10 rounded-xl border border-current/15 p-4">
      <h2 className="text-base font-semibold">Search and links</h2>
      <p className="mt-2 text-xs opacity-70">
        Some things here are worked out from your writing rather than written by
        you — which scenes mention which characters, what search can find, where
        each scene sits in the book. They can always be rebuilt from your work,
        so rebuilding is safe: nothing you typed depends on it.
      </p>

      {outOfDate.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {outOfDate.length === 1
            ? `“${outOfDate[0]!.label}” is out of date.`
            : `${outOfDate.length} of these are out of date.`}{' '}
          Rebuilding fixes it and changes nothing you wrote.
        </p>
      )}

      <ul className="mt-4 divide-y divide-current/10">
        {plan.map((row) => (
          <li key={row.kind} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-xs opacity-60">{row.describes}</p>
              <p className="mt-1 text-xs opacity-70">
                {row.unavailable
                  ? row.unavailable
                  : row.reason
                    ? `Out of date — ${row.reason}.`
                    : `Up to date — ${(row.builtRows ?? 0).toLocaleString()} entries.`}
              </p>
            </div>
            {!row.unavailable && (
              <button
                disabled={busy !== null}
                onClick={() => void run(row.kind)}
                className="shrink-0 text-xs underline opacity-70 disabled:opacity-40">
                {busy === row.kind ? 'Rebuilding…' : 'Rebuild'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          disabled={busy !== null}
          onClick={() => void run('all')}
          className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy === 'all' ? 'Rebuilding…' : 'Rebuild everything'}
        </button>
        {progress && (
          <span className="text-xs tabular-nums opacity-60">
            {progress.kind} — {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
          </span>
        )}
      </div>

      {outcomes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs opacity-70">
          {outcomes.map((o) => (
            <li key={o.kind}>
              {o.error
                // Shown, not swallowed. The row keeps the message too, so the
                // next session still knows.
                ? `${o.kind}: couldn’t rebuild — ${o.error}`
                : o.skipped
                  ? `${o.kind}: skipped — ${o.skipped}`
                  : `${o.kind}: ${o.rows.toLocaleString()} entries in ${o.ms.toLocaleString()} ms`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
