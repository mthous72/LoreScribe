import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import type { Beat, BeatRole, SceneBeat } from '../data/planRepository';

/**
 * What this scene has to accomplish.
 *
 * The one thing on this screen the compiler cannot infer. Facts say what is
 * true, the cast says who is here, and neither says what the scene is *for* —
 * doc 03 gives that its own field, `beats: BeatTarget[]`, and generating against
 * an empty one is generating against no target ([D29](../../docs/10-decisions.md)).
 *
 * It sits beside the prose rather than on the plan screen because that is where
 * the question gets asked. A writer stuck halfway down a scene wants to see what
 * it was supposed to do, not to go and look it up.
 */

const ROLES: BeatRole[] = ['setup', 'develop', 'payoff', 'echo'];

export function SceneBeats({ projectId, sceneId, bookId }: {
  projectId: string;
  sceneId: string;
  bookId: string | null;
}) {
  const db = useDb();
  const [serving, setServing] = useState<SceneBeat[]>([]);
  const [available, setAvailable] = useState<Beat[]>([]);
  const [generation, setGeneration] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const [mine, all] = await Promise.all([
        db.plan.beatsForScene(sceneId),
        bookId ? db.plan.listBeats(bookId) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      setServing(mine);
      setAvailable(all);
    })();
    return () => { cancelled = true; };
  }, [db, sceneId, bookId, generation]);

  const act = useCallback(async (job: () => Promise<void>) => {
    await job();
    setGeneration((g) => g + 1);
  }, []);

  if (db.state !== 'ready') return null;
  const mine = new Set(serving.map((b) => b.beatId));
  const spare = available.filter((b) => !mine.has(b.id));

  return (
    <section className="mt-4" data-testid="scene-beats">
      <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
        What this scene has to do
      </h2>

      {serving.length === 0 ? (
        <p className="mt-2 text-xs opacity-60">
          No beat yet.{' '}
          <Link to={`/project/${projectId}/plan`} className="underline">
            Plan one
          </Link>
          , and this scene can carry it — a scene with no beat is one the tool
          has nothing to aim at.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {serving.map((beat) => (
            <li
              key={beat.beatId}
              data-scene-beat={beat.beatId}
              className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm
                         hover:bg-current/5">
              <span className="shrink-0 text-xs opacity-50">{beat.arcName}</span>
              <span className="min-w-0 flex-1 truncate">{beat.title}</span>
              {beat.function && (
                <span className="shrink-0 text-xs opacity-50">{beat.function}</span>
              )}
              <select
                aria-label={`Role of ${beat.title} in this scene`}
                value={beat.role}
                onChange={(e) => void act(() =>
                  db.plan.linkBeat(beat.beatId, sceneId, e.target.value as BeatRole))}
                className="shrink-0 rounded border border-current/20 bg-transparent px-1 py-0.5 text-xs">
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <button
                onClick={() => void act(() => db.plan.unlinkBeat(beat.beatId, sceneId))}
                className="shrink-0 text-xs underline opacity-50">
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {spare.length > 0 && (
        <div className="mt-2">
          {adding ? (
            <select
              autoFocus
              aria-label="Add a beat to this scene"
              defaultValue=""
              onChange={(e) => {
                const id = e.target.value;
                setAdding(false);
                if (id) void act(() => db.plan.linkBeat(id, sceneId, 'develop'));
              }}
              onBlur={() => setAdding(false)}
              className="rounded-lg border border-current/20 bg-transparent px-2 py-1 text-xs">
              <option value="">choose a beat…</option>
              {spare.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="px-1 text-xs underline opacity-60">
              Add a beat
            </button>
          )}
        </div>
      )}
    </section>
  );
}
