import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDb } from './DbProvider';
import type { SceneSummary } from '../data/manuscriptRepository';
import type { SceneVersion } from '../data/versionsRepository';
import { collapse, diffParagraphs, diffStats, type DiffLine, type Run } from '../text/diff';

/**
 * Kept drafts of this scene, and what changed between two of them.
 *
 * Three things here are decisions rather than layout:
 *
 * **Keeping a draft flushes the editor first.** The prose a writer can see is
 * up to `SAVE_AFTER_MS` ahead of the database, so a snapshot taken straight
 * from the table is a snapshot missing the sentence they just finished — and
 * nothing on screen would say so. `flushAll` closes that window before every
 * read of the current text, not only before the snapshot.
 *
 * **Restoring remounts the editor.** The editor owns the document in memory;
 * writing to the scene underneath it would leave the old prose on screen, and
 * its next autosave would put that prose straight back over the restore. So a
 * restore tells the page, the page changes the editor's key, and the editor
 * reloads from the database it just changed.
 *
 * **The way back is offered by name.** A restore keeps what was on the page as
 * its own draft, and this says so with a button rather than expecting the
 * writer to work out that the unnamed draft at the top of the list is their
 * work. A history a writer is afraid to click is not a history.
 */

/** The sentinel for "the prose as it stands", which is not a version row. */
const CURRENT = 'current';

/**
 * How often the live side of a comparison is re-read.
 *
 * The same reasoning as `SceneCast`: the prose reaches the database on the
 * editor's own debounce, so a diff read once when the panel opened would be
 * right, and then wrong for as long as the writer keeps typing. This polls the
 * SAVED text and deliberately does not flush — a diff that forced a write every
 * two seconds would take the debounce away from the editor that owns it. The
 * actions that must be exact flush for themselves.
 */
const REFRESH_MS = 2_000;

interface Side { id: string; text: string }

export function SceneVersions({ projectId, scene, onRestored }: {
  projectId: string;
  scene: SceneSummary;
  /** The scene's prose was replaced; the editor has to be reloaded. */
  onRestored: () => void;
}) {
  const db = useDb();
  const [versions, setVersions] = useState<SceneVersion[]>([]);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState<{ text: string; undoId?: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Derived rather than stored, so the newest draft is the default without an
  // effect that writes state on load — which would race the load it follows.
  const [chosenFrom, setChosenFrom] = useState<string | null>(null);
  const from = chosenFrom ?? versions[0]?.id ?? null;
  const [to, setTo] = useState<string>(CURRENT);

  const [sides, setSides] = useState<{ from: Side; to: Side } | null>(null);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const next = await db.versions.list(scene.id);
      if (!cancelled) setVersions(next);
    })();
    return () => { cancelled = true; };
  }, [db, scene.id, generation]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    const read = async (id: string): Promise<Side> => {
      if (id === CURRENT) {
        const content = await db.manuscript.getSceneContent(scene.id);
        return { id, text: content?.contentText ?? '' };
      }
      const version = await db.versions.get(id);
      return { id, text: version?.contentText ?? '' };
    };
    const load = async () => {
      if (!from) { if (!cancelled) setSides(null); return; }
      const [a, b] = await Promise.all([read(from), read(to)]);
      if (cancelled) return;
      // Unchanged text keeps the same object. The diff is memoised on identity,
      // and a fresh object every two seconds would re-diff a whole scene to
      // produce the picture already on the screen.
      setSides((prev) => (prev
        && prev.from.id === a.id && prev.from.text === a.text
        && prev.to.id === b.id && prev.to.text === b.text) ? prev : { from: a, to: b });
    };
    void load();
    if (from !== CURRENT && to !== CURRENT) return () => { cancelled = true; };
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [db, scene.id, from, to, generation]);

  const changes = useMemo(
    () => (sides ? diffParagraphs(sides.from.text, sides.to.text) : null), [sides]);
  const lines = useMemo<DiffLine[]>(() => (changes ? collapse(changes, 1) : []), [changes]);
  const stats = useMemo(() => (changes ? diffStats(changes) : null), [changes]);

  const act = useCallback(async (job: () => Promise<void>) => {
    setBusy(true);
    try { await job(); }
    catch (e) { setNote({ text: (e as Error).message ?? String(e) }); }
    finally { setBusy(false); reload(); }
  }, [reload]);

  if (db.state !== 'ready') return null;

  const keep = () => void act(async () => {
    if (db.state !== 'ready') return;
    // Before reading the scene, not after: the last sentence is still behind
    // the editor's debounce until this returns.
    await db.flushAll();
    const { created, version } = await db.versions.snapshot(scene.id, {
      label: label.trim() || null,
    });
    setLabel('');
    setChosenFrom(version.id);
    setTo(CURRENT);
    setNote({
      text: created
        ? 'Kept. Anything you write from here can be compared against it.'
        : 'Nothing has changed since the last draft you kept, so there is nothing new to keep.',
    });
  });

  const restore = (version: SceneVersion) => void act(async () => {
    if (db.state !== 'ready') return;
    await db.flushAll();
    const { keptId } = await db.versions.restore(projectId, version.id);
    setChosenFrom(version.id);
    setTo(CURRENT);
    onRestored();
    setNote({
      text: keptId
        ? `Restored ${name(version)}. What was on the page is kept as a draft of its own.`
        : `Restored ${name(version)}.`,
      undoId: keptId ?? undefined,
    });
  });

  const options = [
    ...versions.map((v) => ({ value: v.id, text: `${name(v)} · ${when(v.createdAt)}` })),
    { value: CURRENT, text: 'The prose as it stands' },
  ];

  return (
    <section className="mt-6" data-testid="scene-versions">
      <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">Drafts</h2>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="draft-label">Name this draft</label>
        <input
          id="draft-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="draft 2, or: what if she stays"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent
                     px-2.5 py-1.5 text-sm"
        />
        <button
          onClick={keep}
          disabled={busy}
          className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                     font-medium disabled:opacity-50">
          Keep this version
        </button>
      </div>

      {note && (
        <p aria-live="polite" className="mt-2 flex flex-wrap items-baseline gap-2 text-xs opacity-70">
          <span>{note.text}</span>
          {note.undoId && (
            <button
              onClick={() => {
                const back = versions.find((v) => v.id === note.undoId);
                if (back) restore(back);
              }}
              className="underline">
              Put it back
            </button>
          )}
        </p>
      )}

      {versions.length === 0 ? (
        <p className="mt-3 text-xs opacity-60">
          No kept drafts yet. Keeping one costs nothing and makes every later
          change something you can look at — and undo.
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-1">
            {versions.map((version) => (
              <li
                key={version.id}
                data-version-id={version.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5
                           text-sm hover:bg-current/5">
                {renaming === version.id ? (
                  <input
                    autoFocus
                    defaultValue={version.label ?? ''}
                    aria-label={`Rename ${name(version)}`}
                    onBlur={(e) => {
                      setRenaming(null);
                      void act(() => db.versions.relabel(version.id, e.target.value));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-current/20 bg-transparent
                               px-1 py-0.5 text-sm"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{name(version)}</span>
                )}

                {version.isActive && (
                  <span
                    data-active="true"
                    title="The prose on the page was taken from this draft"
                    className="shrink-0 rounded-full border border-current/20 px-1.5 text-xs
                               opacity-60">
                    on the page
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums opacity-50">
                  {version.wordCount.toLocaleString()} words · {when(version.createdAt)}
                </span>

                <button
                  disabled={busy}
                  // Flushed, unlike the poll above: a writer who asked for this
                  // comparison means the words in front of them, not the words
                  // as of the last debounce.
                  onClick={() => void act(async () => {
                    if (db.state !== 'ready') return;
                    await db.flushAll();
                    setChosenFrom(version.id);
                    setTo(CURRENT);
                  })}
                  className="shrink-0 text-xs underline opacity-60 disabled:opacity-30">
                  compare
                </button>
                <button
                  disabled={busy}
                  onClick={() => restore(version)}
                  className="shrink-0 text-xs underline opacity-60 disabled:opacity-30">
                  restore
                </button>
                <button
                  disabled={busy}
                  onClick={() => setRenaming(version.id)}
                  className="shrink-0 text-xs underline opacity-60 disabled:opacity-30">
                  rename
                </button>
                {/* Two steps, unlike everything else that deletes here: a scene
                    is a tombstone and comes back, a discarded draft does not. */}
                {confirming === version.id ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      void act(() => db.versions.remove(version.id));
                    }}
                    className="shrink-0 text-xs underline opacity-80 disabled:opacity-30">
                    delete for good?
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => setConfirming(version.id)}
                    className="shrink-0 text-xs underline opacity-60 disabled:opacity-30">
                    delete
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="diff-from" className="opacity-60">Compare</label>
            <Picker
              id="diff-from" value={from ?? ''} options={options}
              onChange={setChosenFrom} label="Compare" />
            <label htmlFor="diff-to" className="opacity-60">with</label>
            <Picker
              id="diff-to" value={to} options={options}
              onChange={(v) => setTo(v)} label="with" />
            {stats && (
              <span data-testid="diff-stats" className="tabular-nums opacity-60">
                +{stats.added} −{stats.removed}
              </span>
            )}
          </div>

          {/* Three states, said plainly. "No difference" and "nothing loaded
              yet" look identical if both render an empty list, and a writer
              reading an empty diff has no way to tell which they are seeing. */}
          {!changes
            ? <p className="mt-3 text-xs opacity-60">Nothing to compare yet.</p>
            : changes.every((c) => c.kind === 'equal')
              ? <p className="mt-3 text-xs opacity-60">These two are word for word the same.</p>
              : <Diff lines={lines} />}
        </>
      )}
    </section>
  );
}

function Picker({ id, value, options, onChange, label }: {
  id: string;
  value: string;
  options: { value: string; text: string }[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[14rem] rounded-lg border border-current/20 bg-transparent px-2 py-1">
      {options.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
    </select>
  );
}

/**
 * The diff itself.
 *
 * Colour is never the only signal: an inserted paragraph is also marked `+`, a
 * deleted one `−`, and a changed word is struck through as well as tinted. A
 * diff a red-green colourblind writer cannot read is a diff that does not work
 * for a tenth of them.
 */
function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div data-testid="diff" className="mt-3 space-y-1.5 text-sm leading-relaxed">
      {lines.map((line, i) => {
        if (line.kind === 'gap') {
          return (
            <p key={i} className="py-1 text-center text-xs opacity-40">
              ⋯ {line.paragraphs} unchanged paragraph{line.paragraphs === 1 ? '' : 's'}
            </p>
          );
        }
        if (line.kind === 'equal') {
          return <p key={i} className="opacity-50">{line.text}</p>;
        }
        if (line.kind === 'insert') {
          return <p key={i} data-diff="insert" className={`${ADDED} rounded px-1.5 py-0.5`}>
            <Marker sign="+" /> {line.text}
          </p>;
        }
        if (line.kind === 'delete') {
          return <p key={i} data-diff="delete" className={`${REMOVED} rounded px-1.5 py-0.5`}>
            <Marker sign="−" /> <s>{line.text}</s>
          </p>;
        }
        return (
          <p key={i} data-diff="changed" className="rounded px-1.5 py-0.5">
            <Marker sign="~" /> <Words runs={line.runs} />
          </p>
        );
      })}
    </div>
  );
}

const ADDED = 'bg-emerald-500/15';
const REMOVED = 'bg-rose-500/15';

function Marker({ sign }: { sign: string }) {
  return <span aria-hidden="true" className="select-none pr-1 font-mono opacity-40">{sign}</span>;
}

function Words({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((run, i) => {
        if (run.kind === 'equal') return <span key={i}>{run.text}</span>;
        if (run.kind === 'insert') {
          return <ins key={i} data-run="insert" className={`${ADDED} no-underline`}>{run.text}</ins>;
        }
        return <del key={i} data-run="delete" className={REMOVED}>{run.text}</del>;
      })}
    </>
  );
}

const name = (v: SceneVersion) => v.label ?? `Unnamed draft, ${when(v.createdAt)}`;

/** Short and local. A writer comparing two drafts cares about which is newer. */
function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
