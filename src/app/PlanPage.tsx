import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import type { ArcKind, Matrix } from '../data/planRepository';

/**
 * Arcs, their beats, and which scenes carry them.
 *
 * A beat is what a scene has to accomplish, which is why this screen exists
 * before the compiler rather than after it ([D29](../../docs/10-decisions.md)).
 *
 * The grid is the centre, not a report. Doc 05 describes the `beat_scene` join
 * rendered as a matrix where unrealised beats and orphan scenes both jump out —
 * and since a cell is exactly the link itself, clicking one is the most direct
 * way to say "this scene carries that beat". Building the list and the grid as
 * separate screens would mean planning in one place and linking in another,
 * with nothing showing the shape of what is still unwritten.
 *
 * The two markers come from `findGaps`, not from a rule written here. It has
 * been tested since Phase 0b with no caller; this is one of its two.
 */

const ARC_KINDS: ArcKind[] = [
  'main_plot', 'subplot', 'character', 'relationship', 'mystery', 'theme',
];
const FUNCTIONS = [
  '', 'setup', 'inciting', 'turn', 'midpoint', 'crisis', 'climax', 'resolution',
];

export function PlanPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [bookId, setBookId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const [busy, setBusy] = useState(false);
  const [arcName, setArcName] = useState('');
  const [arcKind, setArcKind] = useState<ArcKind>('main_plot');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const books = await db.manuscript.listBooks(projectId);
      const first = books[0];
      const grid = first ? await db.plan.matrix(first.id) : null;
      if (cancelled) return;
      setBookId(first?.id ?? null);
      setMatrix(grid);
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  const act = useCallback(async (job: () => Promise<void>) => {
    setBusy(true);
    try { await job(); } finally { setBusy(false); reload(); }
  }, [reload]);

  if (db.state !== 'ready') return null;

  const unrealised = new Set(
    matrix?.gaps.filter((g) => g.type === 'unrealised_beat').map((g) => g.target.id) ?? []);
  const orphan = new Set(
    matrix?.gaps.filter((g) => g.type === 'orphan_scene').map((g) => g.target.id) ?? []);
  const linked = new Map<string, string>();
  for (const { beats } of matrix?.arcs ?? []) {
    for (const b of beats) for (const s of b.sceneIds) linked.set(`${b.id}:${s}`, 'yes');
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">
        ← Manuscript
      </Link>
      <h1 className="mt-4 text-xl font-semibold">The plan</h1>
      <p className="mt-2 text-sm opacity-70">
        An arc is a thing that changes; a beat is one step of it. A scene can
        carry several beats, and a beat can be set up in one scene and paid off
        chapters later — so the grid below is where the two meet.
      </p>

      {!bookId && (
        <p className="mt-6 text-sm opacity-70">
          Make a book first, and there will be scenes for beats to land in.
        </p>
      )}

      {bookId && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="arc-name">New arc name</label>
            <input
              id="arc-name"
              value={arcName}
              onChange={(e) => setArcName(e.target.value)}
              placeholder="Ilva takes the seal"
              className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm"
            />
            <select
              aria-label="Kind of arc"
              value={arcKind}
              onChange={(e) => setArcKind(e.target.value as ArcKind)}
              className="rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
              {ARC_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
            </select>
            <button
              disabled={busy || !arcName.trim()}
              onClick={() => void act(async () => {
                await db.plan.createArc(bookId, arcName.trim(), arcKind);
                setArcName('');
              })}
              className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                         font-medium disabled:opacity-50">
              Add an arc
            </button>
          </div>

          {matrix?.arcs.length === 0 && (
            <p className="mt-4 text-sm opacity-60">
              No arcs yet. Most books have one main plot and two or three others
              running under it.
            </p>
          )}

          <ol className="mt-5 space-y-5">
            {matrix?.arcs.map(({ arc, beats }) => (
              <li key={arc.id} data-arc={arc.id}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h2 className="text-sm font-medium">{arc.name}</h2>
                  <span className="text-xs opacity-50">{arc.kind.replace('_', ' ')}</span>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => db.plan.removeArc(arc.id))}
                    className="text-xs underline opacity-50 disabled:opacity-30">
                    delete arc
                  </button>
                </div>

                <ul className="mt-1 space-y-1">
                  {beats.map((beat) => (
                    <li key={beat.id} data-beat={beat.id}>
                      <div className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5
                                      text-sm hover:bg-current/5">
                        <span className="min-w-0 flex-1 truncate">{beat.title}</span>
                        {unrealised.has(beat.id) && (
                          <span
                            data-unrealised="true"
                            title="Planned, but no scene realises it"
                            className="shrink-0 rounded-full border border-current/25 px-1.5 text-xs opacity-70">
                            no scene yet
                          </span>
                        )}
                        <select
                          aria-label={`Function of ${beat.title}`}
                          value={beat.function ?? ''}
                          onChange={(e) => void act(() =>
                            db.plan.updateBeat(beat.id, { function: e.target.value || null }))}
                          className="shrink-0 rounded border border-current/20 bg-transparent px-1 py-0.5 text-xs">
                          {FUNCTIONS.map((f) => (
                            <option key={f} value={f}>{f || 'no function'}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => setOpen(open === beat.id ? null : beat.id)}
                          className="shrink-0 text-xs underline opacity-60">
                          {open === beat.id ? 'hide' : 'notes'}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void act(() => db.plan.removeBeat(beat.id))}
                          className="shrink-0 text-xs underline opacity-50 disabled:opacity-30">
                          delete
                        </button>
                      </div>
                      {open === beat.id && (
                        <textarea
                          rows={2}
                          aria-label={`What ${beat.title} has to do`}
                          defaultValue={beat.summary ?? ''}
                          onBlur={(e) => {
                            const v = e.target.value.trim() || null;
                            if (v !== beat.summary) {
                              void act(() => db.plan.updateBeat(beat.id, { summary: v }));
                            }
                          }}
                          className="mt-1 w-full rounded-lg border border-current/20 bg-transparent
                                     px-2 py-1.5 text-sm"
                        />
                      )}
                    </li>
                  ))}
                  <li>
                    <AddBeat
                      disabled={busy}
                      onAdd={(title) => void act(async () => {
                        await db.plan.createBeat(arc.id, title);
                      })}
                    />
                  </li>
                </ul>
              </li>
            ))}
          </ol>

          {matrix && matrix.scenes.length > 0 && matrix.arcs.some((a) => a.beats.length > 0) && (
            <section className="mt-10">
              <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
                Beats against scenes
              </h2>
              <p className="mt-1 text-xs opacity-60">
                Click a cell to say that scene carries that beat. A column with
                nothing in it is a written scene serving no beat; a row with
                nothing in it is a beat nothing realises yet.
              </p>
              {/* The only thing on any screen allowed to scroll sideways: a grid
                  is as wide as the book is long. */}
              <div className="mt-3 overflow-x-auto">
                <table className="text-xs" data-testid="matrix">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-inherit p-1 text-left font-medium">Beat</th>
                      {matrix.scenes.map((s) => (
                        <th
                          key={s.id}
                          data-orphan={orphan.has(s.id) ? 'true' : undefined}
                          title={`${s.chapterTitle ?? ''} — ${s.title ?? 'Untitled'}`}
                          className={`p-1 align-bottom font-normal ${orphan.has(s.id) ? 'opacity-100' : 'opacity-60'}`}>
                          <span className="block max-w-[3rem] truncate">
                            {s.title ?? 'Untitled'}
                          </span>
                          {orphan.has(s.id) && <span className="block opacity-70">no beat</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.arcs.flatMap(({ arc, beats }) => beats.map((beat) => (
                      <tr key={beat.id}>
                        <th
                          scope="row"
                          className="sticky left-0 max-w-[12rem] truncate bg-inherit p-1
                                     text-left font-normal">
                          <span className="opacity-50">{arc.name}: </span>{beat.title}
                        </th>
                        {matrix.scenes.map((s) => {
                          const on = linked.has(`${beat.id}:${s.id}`);
                          return (
                            <td key={s.id} className="p-0.5 text-center">
                              <button
                                disabled={busy}
                                aria-label={`${beat.title} in ${s.title ?? 'Untitled'}`}
                                aria-pressed={on}
                                onClick={() => void act(() => (on
                                  ? db.plan.unlinkBeat(beat.id, s.id)
                                  : db.plan.linkBeat(beat.id, s.id, 'develop')))}
                                className={`h-6 w-6 rounded border border-current/20
                                            ${on ? 'bg-current/40' : 'hover:bg-current/10'}`}>
                                <span className="sr-only">{on ? 'linked' : 'not linked'}</span>
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AddBeat({ onAdd, disabled }: { onAdd: (title: string) => void; disabled: boolean }) {
  const [title, setTitle] = useState('');
  const add = () => {
    if (!title.trim()) return;
    onAdd(title.trim());
    setTitle('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1">
      <label className="sr-only" htmlFor="new-beat">New beat</label>
      <input
        id="new-beat"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        placeholder="what has to happen"
        className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm"
      />
      <button
        disabled={disabled || !title.trim()}
        onClick={add}
        className="text-xs underline opacity-70 disabled:opacity-30">
        Add a beat
      </button>
    </div>
  );
}
