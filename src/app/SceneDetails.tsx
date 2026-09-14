import { useCallback, useEffect, useState } from 'react';
import { useDb } from './DbProvider';
import type { Entity } from '../data/codexRepository';
import type { SceneDetails as Details, SceneDetailsPatch } from '../data/manuscriptRepository';

/**
 * What the scene is, as opposed to what it says.
 *
 * Every field here is read by the scene brief compiler, and until this panel
 * existed none of them could be set: `pov_entity_id`, `pov_mode`, `tense`,
 * `location_entity_id`, `purpose` and `summary` were written by the corpus
 * generator and by tests, and by nothing a writer could reach. The plumbing was
 * all there and fed a permanent null, which is the kind of gap that looks
 * covered — the spoiler rule's POV branch is exhaustively tested, and the facts
 * page demonstrates it with a dropdown — right up until a brief is compiled
 * against a manuscript where no scene has a point of view.
 *
 * **POV is not a label.** `detectSpans` derives `mention.role = 'pov'` from it,
 * and adds that mention whether or not the prose ever names the character —
 * which is the whole point of a close-third scene. So setting it changes the
 * graph, and the change has to reach the index.
 */

const POV_MODES = [
  { value: '', text: 'not set' },
  { value: 'first', text: 'first person' },
  { value: 'close_third', text: 'close third' },
  { value: 'third', text: 'third' },
  { value: 'omniscient', text: 'omniscient' },
];
const TENSES = [
  { value: '', text: 'not set' },
  { value: 'past', text: 'past' },
  { value: 'present', text: 'present' },
];
const STATUSES = ['planned', 'drafted', 'revised', 'final'];

export function SceneDetails({ projectId, sceneId, onPovChanged }: {
  projectId: string;
  sceneId: string;
  /**
   * POV moved, so the editor's decorations are compiled against the wrong one.
   * The parent reloads it — the same path a restored draft takes.
   */
  onPovChanged: () => void;
}) {
  const db = useDb();
  const [details, setDetails] = useState<Details | null>(null);
  const [people, setPeople] = useState<Entity[]>([]);
  const [places, setPlaces] = useState<Entity[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const [scene, entities] = await Promise.all([
        db.manuscript.getSceneDetails(sceneId),
        db.codex.listEntities(projectId),
      ]);
      if (cancelled) return;
      setDetails(scene);
      // Characters lead the POV list and places the location list, but neither
      // is restricted to them: a scene told from a city's point of view is a
      // choice a writer is allowed to make, and a tool that forbids it is
      // asserting something about fiction it has no business asserting.
      setPeople(sorted(entities, 'character'));
      setPlaces(sorted(entities, 'location'));
    })();
    return () => { cancelled = true; };
  }, [db, projectId, sceneId]);

  const save = useCallback(async (patch: SceneDetailsPatch) => {
    if (db.state !== 'ready') return;
    // Changing POV rebuilds the editor, and the rebuild reads the scene back
    // from the database — so prose still behind the autosave debounce is a
    // question worth answering before the write.
    //
    // It turns out not to be a live race, and the honest reason is worth
    // recording: `SceneEditor` gates on `loaded.token !== reloadToken`, so the
    // surface unmounts on the very next render and its cleanup flush lands
    // before the refetch resolves. Deleting this line and running the test that
    // covers it proves that — it still passes. The line stays because it makes
    // an implicit ordering dependency explicit and costs nothing when there is
    // nothing pending, not because it is what saves the sentence.
    if ('povEntityId' in patch) await db.flushAll();
    setDetails((d) => (d ? { ...d, ...patch } : d));
    await db.manuscript.updateScene(sceneId, patch);
    if ('povEntityId' in patch) {
      // The mention graph changed, not just a column. Re-detect before telling
      // the page, so what it reloads is already correct.
      await db.manuscript.reindexScene(projectId, sceneId);
      onPovChanged();
    }
    setNote('Saved');
  }, [db, projectId, sceneId, onPovChanged]);

  if (db.state !== 'ready' || !details) return null;

  const field = (label: string, control: React.ReactNode) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs opacity-60">{label}</span>
      {control}
    </label>
  );
  const select = 'rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm';
  const text = 'rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm';

  return (
    <section className="mt-6" data-testid="scene-details">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
          About this scene
        </h2>
        <span aria-live="polite" className="text-xs opacity-50">{note}</span>
      </div>
      <p className="mt-1 text-xs opacity-60">
        Nothing here is required. All of it is what a scene brief will be
        compiled from, so a scene with none of it set gets a thinner one.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {field('Point of view', (
          <select
            aria-label="Point of view"
            value={details.povEntityId ?? ''}
            onChange={(e) => void save({ povEntityId: e.target.value || null })}
            className={select}>
            <option value="">not set</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ))}

        {field('Told as', (
          <select
            aria-label="Told as"
            value={details.povMode ?? ''}
            onChange={(e) => void save({ povMode: e.target.value || null })}
            className={select}>
            {POV_MODES.map((m) => <option key={m.value} value={m.value}>{m.text}</option>)}
          </select>
        ))}

        {field('Tense', (
          <select
            aria-label="Tense"
            value={details.tense ?? ''}
            onChange={(e) => void save({ tense: e.target.value || null })}
            className={select}>
            {TENSES.map((t) => <option key={t.value} value={t.value}>{t.text}</option>)}
          </select>
        ))}

        {field('Where', (
          <select
            aria-label="Where"
            value={details.locationEntityId ?? ''}
            onChange={(e) => void save({ locationEntityId: e.target.value || null })}
            className={select}>
            <option value="">not set</option>
            {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ))}

        {field('How it is going', (
          <select
            aria-label="How it is going"
            value={details.status ?? 'planned'}
            onChange={(e) => void save({ status: e.target.value })}
            className={select}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ))}

        {field('Tension, 0 to 10', (
          <input
            type="number" min={0} max={10}
            aria-label="Tension, 0 to 10"
            defaultValue={details.tension ?? ''}
            // On blur, not on change: typing "10" passes through "1", and
            // saving that writes a number the writer never meant.
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const n = raw === '' ? null : Math.max(0, Math.min(10, Number(raw)));
              if (n !== details.tension) void save({ tension: n });
            }}
            className={text}
          />
        ))}
      </div>

      <div className="mt-3 grid gap-3">
        {field('What this scene has to do', (
          <textarea
            rows={2}
            aria-label="What this scene has to do"
            defaultValue={details.purpose ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== details.purpose) void save({ purpose: v });
            }}
            className={text}
          />
        ))}
        {field('In a line, for later', (
          <textarea
            rows={2}
            aria-label="In a line, for later"
            defaultValue={details.summary ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== details.summary) void save({ summary: v });
            }}
            className={text}
          />
        ))}
      </div>
    </section>
  );
}

/** The named kind first, then everyone else — never only the named kind. */
function sorted(entities: readonly Entity[], typeKey: string): Entity[] {
  return [...entities].sort((a, b) => {
    const rank = (e: Entity) => (e.typeKey === typeKey ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, 'en');
  });
}
