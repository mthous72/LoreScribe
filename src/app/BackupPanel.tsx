import { useCallback, useEffect, useState } from 'react';
import { useDb } from './DbProvider';
import {
  exportProjectArchive, downloadArchive, writeSnapshot, backupStatus,
  type BackupStatus,
} from '../data/backup';

const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
const ago = (ms: number) => {
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return 'just now';
};

/**
 * D9's mitigation, stated honestly.
 *
 * The snapshot is automatic and lives in the same evictable storage as the
 * database, so it defends against this app's mistakes and not against the
 * browser reclaiming the origin. The export is durable and cannot be automatic,
 * because a browser will not write to disk without a gesture. Saying both
 * plainly is the feature — a panel that claimed "backed up" while only holding
 * a snapshot would make a writer stop worrying about the one thing that can
 * still take the novel.
 */
export function BackupPanel({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const db = useDb();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Read from a ticker rather than Date.now() during render: "how long ago"
  // changes on its own, and a render is not allowed to depend on when it ran.
  const [now, setNow] = useState(0);

  const refresh = useCallback(async () => setStatus(await backupStatus()), []);

  const snapshot = useCallback(async () => {
    if (db.state !== 'ready') return;
    const { text, rows } = await exportProjectArchive(db.driver, projectId, db.diagnostics.userVersion);
    const written = await writeSnapshot(text);
    await refresh();
    return { rows, written };
  }, [db, projectId, refresh]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let stop = false;
    void (async () => { await snapshot(); if (!stop) await refresh(); })();
    const timer = setInterval(() => { void snapshot(); }, AUTO_SNAPSHOT_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { stop = true; clearInterval(timer); clearInterval(tick); };
  }, [db.state, snapshot, refresh]);

  if (db.state !== 'ready' || !status) return null;
  const last = status.lastExportedAt;
  const since = (at: number) => (now ? ago(now - at) : ago(0));

  return (
    <section className="mt-10 rounded-xl border border-current/15 p-4">
      <h2 className="text-base font-semibold">Backup</h2>

      {status.stale && (
        <p className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {last === null
            ? 'You have never saved a copy outside this browser. If the browser clears its storage, everything here goes with it.'
            : `Your last saved copy was ${since(last)}. Browser storage can be reclaimed without warning.`}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="opacity-60">Saved to a file</dt>
          <dd className="font-medium">{last === null ? 'never' : since(last)}</dd>
        </div>
        <div>
          <dt className="opacity-60">In-browser snapshots</dt>
          <dd className="font-medium tabular-nums">{status.snapshots.length}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs opacity-70">
        Snapshots are taken automatically every ten minutes, but they live in the
        same browser storage as your work — they survive a mistake in this app,
        not the browser clearing its data. Only a saved file survives that, and a
        browser won&rsquo;t write one without you asking.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (db.state !== 'ready') return;
              const { text, rows, bytes } = await exportProjectArchive(
                db.driver, projectId, db.diagnostics.userVersion);
              downloadArchive(text, projectTitle);
              await refresh();
              setNote(`Saved ${rows.toLocaleString()} records (${Math.max(1, Math.round(bytes / 1024))} KB).`);
            } finally { setBusy(false); }
          }}
          className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? 'Preparing…' : 'Save a copy to a file'}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await snapshot();
              setNote(r?.written ? `Snapshot taken (${r.rows.toLocaleString()} records).` : 'Could not write a snapshot here.');
            } finally { setBusy(false); }
          }}
          className="rounded-lg px-4 py-2 text-sm underline opacity-70">
          Snapshot now
        </button>
      </div>

      {note && <p className="mt-3 text-xs opacity-70">{note}</p>}
    </section>
  );
}
