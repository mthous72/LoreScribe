import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import type { EntityMention } from '../data/codexRepository';

/**
 * Who and what is in this scene.
 *
 * The `mention` rows have existed for several commits with nowhere to be seen.
 * This is the smaller half of what they are for: a decoration tells a writer
 * that Ilva is on the screen in front of them, but the list tells them who the
 * scene is actually about — including the POV character, who a close-third
 * scene may never name.
 *
 * Read on a delay rather than instantly, because the editor re-detects mentions
 * on an idle timer: showing this the moment a scene opens would be right, and
 * then wrong for four seconds after the writer types a name, and right again.
 * Polling while the scene is open costs one indexed query and keeps it honest.
 */

const REFRESH_MS = 2_000;

const ROLE_NOTE: Record<string, string> = {
  pov: 'point of view',
  focus: 'the scene is about them',
  present: 'in the scene',
  mentioned: 'named only',
};

export function SceneCast({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const db = useDb();
  const [cast, setCast] = useState<EntityMention[]>([]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    const read = async () => {
      const next = await db.codex.entitiesInScene(sceneId);
      if (!cancelled) setCast(next);
    };
    void read();
    const timer = setInterval(() => { void read(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [db, sceneId]);

  if (db.state !== 'ready') return null;

  return (
    <section className="mt-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">In this scene</h2>
      {cast.length === 0 ? (
        <p className="mt-2 text-xs opacity-60">
          Nothing from your codex appears here yet. Anything you add to the codex
          with a matching name is picked up as you write.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {cast.map((c) => (
            <li key={c.entityId}>
              <Link
                to={`/project/${projectId}/codex?entity=${c.entityId}`}
                title={c.summary ?? ROLE_NOTE[c.role] ?? c.role}
                className="flex items-baseline gap-1.5 rounded-full border border-current/15
                           px-2.5 py-1 text-xs hover:bg-current/5">
                <span>{c.name}</span>
                <span className="opacity-50">{c.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
