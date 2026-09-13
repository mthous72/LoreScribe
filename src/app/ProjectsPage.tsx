import { useEffect, useState } from 'react';
import { useDb } from './DbProvider';
import type { Project } from '../data/projectRepository';
import { BackupPanel } from './BackupPanel';
import { IndexPanel } from './IndexPanel';

export function ProjectsPage() {
  const db = useDb();
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [ops, setOps] = useState(0);
  // Mutations bump this rather than each re-reading for themselves, so there is
  // one place that loads and one place that invalidates.
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((g) => g + 1);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const [list, count] = await Promise.all([db.projects.list(), db.projects.opLogCount()]);
      if (cancelled) return;
      setProjects(list);
      setOps(count);
    })();
    return () => { cancelled = true; };
  }, [db, generation]);

  if (db.state !== 'ready') return null;
  const { storage, diagnostics } = db;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold">Projects</h1>

      <form
        className="mt-6 flex flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          await db.projects.create(title.trim());
          setTitle('');
          refresh();
        }}
      >
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="A working title"
          aria-label="Project title"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm"
        />
        <button type="submit"
          className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
          Create project
        </button>
      </form>

      <ul className="mt-6 divide-y divide-current/10">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-3">
            <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
            <span className="shrink-0 text-xs opacity-50">rev {p.rev}</span>
            <button
              onClick={async () => { await db.projects.remove(p.id); refresh(); }}
              className="shrink-0 text-xs underline opacity-60">
              delete
            </button>
          </li>
        ))}
        {projects.length === 0 && (
          <li className="py-3 text-sm opacity-60">
            Nothing yet. Create one, then reload the page — that it survives is
            the whole point of Phase&nbsp;0.
          </li>
        )}
      </ul>

      {projects[0] && <BackupPanel projectId={projects[0].id} projectTitle={projects[0].title} />}
      {projects[0] && <IndexPanel projectId={projects[0].id} />}

      <dl className="mt-10 grid grid-cols-2 gap-x-4 gap-y-2 text-xs opacity-70 sm:grid-cols-4">
        <Stat label="op_log rows" value={String(ops)} />
        <Stat label="journal mode" value={diagnostics.journalMode} />
        <Stat label="pool files" value={`${diagnostics.fileCount} / ${diagnostics.capacity}`} />
        <Stat
          label="persistent storage"
          value={storage.persisted ? 'granted' : 'refused'}
        />
      </dl>
      {db.uncleanShutdown && (
        // The row outlived the session that wrote it, which means the previous
        // one never released. Worth saying plainly rather than silently
        // overwriting the evidence.
        <p className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          The last session ended without closing the database — a crash, or a
          tab killed by the system. Nothing appears lost; committed work is
          still here. If anything looks wrong, say so before writing more.
        </p>
      )}
      {!storage.persisted && (
        // Say so plainly rather than assuming success. The browser decides this
        // on heuristics and never prompts; D9's scheduled backup is what makes
        // a refusal survivable.
        <p className="mt-3 text-xs opacity-70">
          The browser declined to mark this storage persistent, so it could be
          evicted if the device runs low on space. Keep backups on
          {storage.quotaMb != null && ` — ${storage.usageMb} MB used of ${storage.quotaMb} MB available`}.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="opacity-60">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
