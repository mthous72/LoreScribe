import { useEffect, useRef, useState } from 'react';
import { BackgroundTest, type BackgroundState } from '../spike/backgroundTest';

const mins = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
};

/**
 * R2b, made doable one-handed on a phone.
 *
 * The instructions are on the page rather than in a message somewhere, because
 * the person running this will be holding the device with the app backgrounded
 * and cannot read anything else at the time.
 */
export function BackgroundTestPanel() {
  const [state, setState] = useState<BackgroundState>({
    status: 'idle', longestHiddenMs: 0, totalHiddenMs: 0, probes: [],
  });
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  // Only ever touched from effects and handlers, never during render.
  const testRef = useRef<BackgroundTest | null>(null);

  useEffect(() => {
    const test = new BackgroundTest(setState);
    testRef.current = test;
    // The ticker seeds `now` on its first beat rather than synchronously here;
    // `elapsed` guards against the pre-first-tick zero.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      testRef.current = null;
      void test.stop();
    };
  }, []);

  const held = state.status === 'holding';
  const elapsed = state.startedAt && now ? now - state.startedAt : 0;

  return (
    <section className="mt-10 rounded-xl border border-current/15 p-4">
      <h2 className="text-base font-semibold">Backgrounding test (R2b)</h2>
      <p className="mt-2 text-sm opacity-75">
        Does the database survive you switching away? The storage engine holds the
        file open exclusively, and Android reclaims resources from background
        tabs. This keeps <strong>one</strong> connection open across the
        interruption and then uses it again — opening a second time would prove
        nothing, because fresh handles succeed either way.
      </p>

      {!held && (
        <button
          onClick={() => void testRef.current?.start()}
          className="mt-4 w-full rounded-lg border border-current/20 bg-current/10 px-4 py-3 text-sm font-medium sm:w-auto">
          {state.probes.length ? 'Start again' : 'Start the test'}
        </button>
      )}

      {held && (
        <div className="mt-4 rounded-lg bg-current/5 p-4">
          <p className="text-sm font-medium">Connection open — now leave this tab.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm opacity-80">
            <li>Switch to another app, or lock the screen.</li>
            <li>Wait <strong>at least 10 minutes</strong>. Longer is better. Use
              the camera or a game if you can — memory pressure is what triggers
              reclamation.</li>
            <li>Come back here. It checks automatically; the button is a backup.</li>
          </ol>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums opacity-70">
            <div><dt className="opacity-60">held for</dt><dd>{mins(elapsed)}</dd></div>
            <div><dt className="opacity-60">longest away</dt><dd>{mins(state.longestHiddenMs)}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => void testRef.current?.probe('manual')}
              className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
              Check now
            </button>
            <button onClick={() => void testRef.current?.stop()}
              className="rounded-lg px-4 py-2 text-sm underline opacity-70">
              Stop
            </button>
          </div>
        </div>
      )}

      {state.verdict && (
        <p className={`mt-4 rounded-lg px-3 py-2 text-sm font-semibold ${
          state.verdict === 'survived'
            ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
            : 'bg-red-500/15 text-red-800 dark:text-red-300'}`}>
          {state.verdict === 'survived'
            ? `Handles survived ${mins(state.longestHiddenMs)} backgrounded. R2b is answered — the web path holds on this device.`
            : `Handles were lost. The web path cannot be relied on here; Capacitor moves into Phase 0.`}
        </p>
      )}

      {state.probes.length > 0 && (
        <>
          <ul className="mt-4 space-y-2 text-sm">
            {state.probes.map((p, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 border-b border-current/10 pb-2">
                <span className={`font-semibold ${
                  p.outcome === 'survived'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'}`}>
                  {p.outcome}
                </span>
                <span className="opacity-70">after {mins(p.hiddenForMs)} away</span>
                <span className="text-xs opacity-50">
                  ({p.source}; read {p.readOk ? 'ok' : 'failed'}, write {p.writeOk ? 'ok' : 'failed'})
                </span>
                {p.error && <span className="w-full text-xs opacity-60">{p.error}</span>}
              </li>
            ))}
          </ul>
          <button
            onClick={async () => {
              try {
                const report = testRef.current?.report();
                if (!report) return;
                await navigator.clipboard.writeText(report);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch { /* clipboard blocked; the text is on screen anyway */ }
            }}
            className="mt-3 rounded-lg border border-current/20 px-4 py-2 text-sm">
            {copied ? 'Copied' : 'Copy the report'}
          </button>
        </>
      )}
    </section>
  );
}
