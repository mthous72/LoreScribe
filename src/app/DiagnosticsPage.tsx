import { useState } from 'react';
import { runSpike, type SpikeResult } from '../spike/measure';
import { DEFAULT_SPEC } from '../spike/corpus';
import { BackgroundTestPanel } from './BackgroundTestPanel';

/**
 * Gate A's harness, shipped rather than thrown away. On a phone this is the only
 * honest way to get numbers off the actual device, and in month six it is the
 * baseline a regression is measured against. docs/15 §2, Path C.
 */
export function DiagnosticsPage() {
  const [result, setResult] = useState<SpikeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold">Storage diagnostics</h1>

      {/* R2b first: it is the open question, and it is the one that needs a
          real device rather than a test runner. docs/15 §1. */}
      <BackgroundTestPanel />

      <h2 className="mt-12 text-base font-semibold">Performance spike</h2>
      <p className="mt-2 text-sm opacity-70">
        Builds a {(DEFAULT_SPEC.scenes * DEFAULT_SPEC.wordsPerScene).toLocaleString()}-word
        synthetic project from seed {DEFAULT_SPEC.seed} in a scratch database, measures it,
        and throws it away. Nothing here touches your own work.
      </p>

      <button
        disabled={running}
        onClick={async () => {
          setRunning(true); setLog([]); setResult(null);
          try {
            setResult(await runSpike(DEFAULT_SPEC, {
              clearOnInit: true, log: (s) => setLog((l) => [...l, s]),
            }));
          } finally { setRunning(false); }
        }}
        className="mt-6 rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium disabled:opacity-50">
        {running ? 'Running…' : result ? 'Run again' : 'Run the spike'}
      </button>

      {log.length > 0 && (
        <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-current/5 p-3 text-xs">{log.join('\n')}</pre>
      )}

      {result?.failure && (
        <p className="mt-6 text-sm font-medium text-red-600 dark:text-red-400">
          Could not open: {result.failure.reason} — {result.failure.message}
        </p>
      )}

      {result && !result.failure && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-current/20 text-left text-xs uppercase opacity-60">
                <th className="py-2 pr-3 font-medium">Measure</th>
                <th className="py-2 pr-3 font-medium">Result</th>
                <th className="py-2 pr-3 font-medium">Target</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {result.measurements.map((m) => (
                <tr key={m.key} className="border-b border-current/10 align-top">
                  <td className="py-2 pr-3">
                    {m.label}
                    {m.detail && <span className="block text-xs opacity-60">{m.detail}</span>}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{String(m.value ?? '—')} {m.unit}</td>
                  <td className="py-2 pr-3 text-xs opacity-60">{m.target}</td>
                  <td className={`py-2 text-xs font-semibold ${
                    m.pass === null ? 'opacity-40' : m.pass
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'}`}>
                    {m.pass === null ? '—' : m.pass ? 'pass' : 'FAIL'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs opacity-50">{result.userAgent}</p>
        </div>
      )}
    </div>
  );
}
