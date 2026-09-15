import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import { NoDraftModelError, SpendCapError, type DraftEvent } from '../ai/draft';
import { explainProviderError } from '../ai/explain';
import type { SceneBeat } from '../data/planRepository';
import { raisedStop, usd, type SpendMeter } from '../domain/spend';

/**
 * Draft a beat, from inside the scene.
 *
 * Sits under the beats because that is the question it answers: this scene
 * has to do X — write X. One beat at a time ([D29](../../docs/10-decisions.md)),
 * streamed as it lands so the writer reads along and can stop it, and nothing
 * touches the scene until they accept. Accepting keeps the page as it was as a
 * draft first, so it is one restore away from undone.
 *
 * What it costs is said after, not guessed before: the provider's own token
 * counts against the profile's prices. The window the brief was fitted to is
 * the model's, from the profile — the first time the budget has a real number.
 *
 * Under the controls, what today has cost so far against the project's caps
 * ([D17](../../docs/10-decisions.md)). Past the warning the line says so and
 * drafting continues; at the stop the drafter refuses before it sends
 * anything, and the refusal comes with the raise, one tap, because the stop
 * is a guard against a loop and not a judgement about the work.
 */

const LENGTHS = [
  { value: 150, text: 'short — about 150 words' },
  { value: 300, text: 'a beat — about 300 words' },
  { value: 500, text: 'long — about 500 words' },
];

type Done = Extract<DraftEvent, { kind: 'done' }>;

export function SceneDraft({ projectId, sceneId, onAccepted }: {
  projectId: string;
  sceneId: string;
  onAccepted: () => void;
}) {
  const db = useDb();
  const [beats, setBeats] = useState<SceneBeat[]>([]);
  const [beatId, setBeatId] = useState<string>('');
  const [words, setWords] = useState(300);
  const [text, setText] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [model, setModel] = useState<{ model: string; window: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; needsModel?: boolean; stopped?: SpendMeter } | null>(null);
  const [meter, setMeter] = useState<SpendMeter | null>(null);
  const [meterToken, setMeterToken] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const mine = await db.plan.beatsForScene(sceneId);
      if (!cancelled) setBeats(mine);
    })();
    return () => { cancelled = true; };
  }, [db, sceneId]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const now = await db.spend.meter(projectId);
      if (!cancelled) setMeter(now);
    })();
    return () => { cancelled = true; };
  }, [db, projectId, meterToken]);

  // A draft in flight belongs to the scene it was asked for.
  useEffect(() => () => abort.current?.abort(), []);

  const start = useCallback(async () => {
    if (db.state !== 'ready') return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setText('');
    setDone(null);
    setNote(null);
    try {
      // The ban list and the seam read the prose as saved; the last sentence is
      // still behind the editor's debounce until this returns.
      await db.flushAll();
      for await (const ev of db.drafter.draft(
        { projectId, sceneId, beatId: beatId || null, targetWords: words }, ctl.signal)) {
        if (ev.kind === 'brief') setModel({ model: ev.model, window: ev.window });
        else if (ev.kind === 'text') setText((t) => t + ev.text);
        else setDone(ev);
      }
    } catch (e) {
      if (e instanceof NoDraftModelError) setNote({ text: e.message, needsModel: true });
      else if (e instanceof SpendCapError) setNote({ text: e.message, stopped: e.meter });
      else setNote({ text: explainProviderError(e) });
    } finally {
      setBusy(false);
      abort.current = null;
      setMeterToken((t) => t + 1);
    }
  }, [db, projectId, sceneId, beatId, words]);

  const raise = useCallback(async (from: SpendMeter) => {
    if (db.state !== 'ready') return;
    const stopUsd = raisedStop(from.caps.stopUsd);
    try {
      await db.spend.setCaps(projectId, { warnUsd: Math.min(from.caps.warnUsd, stopUsd), stopUsd });
      setNote({ text: `The stop for this project is now ${usd(stopUsd)} a day. Draft again when you are ready.` });
    } catch (e) {
      setNote({ text: (e as Error).message ?? String(e) });
    } finally {
      setMeterToken((t) => t + 1);
    }
  }, [db, projectId]);

  const accept = useCallback(async () => {
    if (db.state !== 'ready' || !done) return;
    setBusy(true);
    try {
      const { words: total } = await db.drafter.accept(done.runId, sceneId);
      setNote({ text: `Accepted. The scene is now ${total.toLocaleString()} words; what was there before is kept as a draft.` });
      setText('');
      setDone(null);
      onAccepted();
    } catch (e) {
      setNote({ text: (e as Error).message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }, [db, done, sceneId, onAccepted]);

  if (db.state !== 'ready') return null;

  const statusLine = done && (
    done.status === 'ok' ? `${done.words} words`
      : done.status === 'truncated' ? `${done.words} words — the model ran out of room; the beat may be unfinished`
        : done.status === 'cancelled' ? `${done.words} words — stopped here`
          : done.status === 'refused' ? 'The provider declined to write this'
            : done.status
  );

  return (
    <section className="mt-4" data-testid="scene-draft">
      <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">Draft</h2>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Beat to draft"
          value={beatId}
          onChange={(e) => setBeatId(e.target.value)}
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
          <option value="">{beats.length ? 'the next beat, unnamed' : 'no beat on this scene — continue anyway'}</option>
          {beats.map((b) => <option key={b.beatId} value={b.beatId}>{b.arcName}: {b.title}</option>)}
        </select>
        <select
          aria-label="How much to write"
          value={words}
          onChange={(e) => setWords(Number(e.target.value))}
          disabled={busy}
          className="rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
          {LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.text}</option>)}
        </select>
        {busy
          ? (
            <button onClick={() => abort.current?.abort()}
              className="rounded-lg border border-current/20 px-3 py-1.5 text-sm font-medium">
              Stop
            </button>
          ) : (
            <button
              onClick={() => void start()}
              disabled={busy}
              className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                         font-medium disabled:opacity-50">
              Draft this beat
            </button>
          )}
      </div>

      {meter && (
        <p className="mt-1.5 text-xs opacity-60" data-testid="spend-meter" data-level={meter.level}>
          {usd(meter.todayUsd)} spent today on this project
          {meter.level === 'stop' ? ` — at the ${usd(meter.caps.stopUsd)} stop`
            : meter.level === 'warn' ? ` — past the ${usd(meter.caps.warnUsd)} warning, stops at ${usd(meter.caps.stopUsd)}`
              : ` · warns at ${usd(meter.caps.warnUsd)}, stops at ${usd(meter.caps.stopUsd)}`}
          {meter.unpricedRuns > 0 && (
            <> · {meter.unpricedRuns} {meter.unpricedRuns === 1 ? 'run' : 'runs'} had no price and {meter.unpricedRuns === 1 ? 'is' : 'are'} not counted</>
          )}
          {' '}
          <Link to={`/project/${projectId}/providers#spend`} className="underline">change the caps</Link>
        </p>
      )}

      {note && (
        <p aria-live="polite" role="status" className="mt-2 text-xs opacity-80">
          {note.text}
          {note.needsModel && (
            <>
              {' '}
              <Link to={`/project/${projectId}/providers`} className="underline">Providers →</Link>
            </>
          )}
          {note.stopped && (
            <>
              {' '}
              <button
                onClick={() => void raise(note.stopped!)}
                className="rounded border border-current/20 px-2 py-0.5 text-xs font-medium">
                Raise the stop to {usd(raisedStop(note.stopped.caps.stopUsd))} a day
              </button>
            </>
          )}
        </p>
      )}

      {(text || busy) && (
        <div
          data-testid="draft-text"
          aria-live="polite"
          className="mt-3 whitespace-pre-wrap rounded-lg border border-current/15 p-3 text-sm leading-relaxed">
          {text || <span className="opacity-50">Compiling the brief…</span>}
        </div>
      )}

      {done && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs opacity-70" data-testid="draft-done">
          <span>{statusLine}</span>
          {model && <span>{model.model} · {(model.window / 1000).toFixed(0)}k window</span>}
          {done.tokensIn !== null && (
            <span>{done.tokensIn.toLocaleString()} in, {done.tokensOut?.toLocaleString()} out</span>
          )}
          {done.costUsd !== null && <span>${done.costUsd.toFixed(4)}</span>}
          {done.servedBy && <span>served by {done.servedBy}</span>}
          <span className="flex-1" />
          {done.output && (
            <button
              onClick={() => void accept()}
              disabled={busy}
              className="rounded-lg border border-current/20 bg-current/10 px-3 py-1 text-sm font-medium
                         disabled:opacity-50">
              Accept into the scene
            </button>
          )}
          <button
            onClick={() => { setText(''); setDone(null); }}
            disabled={busy}
            className="underline disabled:opacity-30">
            Discard
          </button>
        </div>
      )}
    </section>
  );
}
