import { useRef, useState } from 'react';
import { runEditorSpike, type EditorSpikeResult } from '../spike/editorSpike';

/**
 * Doc 08 lists "Tiptap with a 5000-word scene plus live mention decorations"
 * among the spikes worth doing before Phase 1 ends, with the instruction to
 * measure rather than hope. This is that, on whatever device you open it with.
 */
export function EditorSpikePanel() {
  const [result, setResult] = useState<EditorSpikeResult | null>(null);
  const [running, setRunning] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);

  return (
    <section className="mt-10 rounded-xl border border-current/15 p-4">
      <h2 className="text-base font-semibold">Editor spike</h2>
      <p className="mt-2 text-sm opacity-75">
        A 5,000-word scene in Tiptap with 200 aliases highlighted live, then 120
        simulated keystrokes in the middle of it. Also times what a naive
        whole-document rescan would have cost, so the incremental design has to
        justify itself rather than be assumed.
      </p>

      <button
        disabled={running}
        onClick={async () => {
          setRunning(true);
          setResult(null);
          try {
            if (mountRef.current) setResult(await runEditorSpike(mountRef.current));
          } finally { setRunning(false); }
        }}
        className="mt-4 w-full rounded-lg border border-current/20 bg-current/10 px-4 py-3 text-sm font-medium disabled:opacity-50 sm:w-auto">
        {running ? 'Measuring…' : result ? 'Run again' : 'Run the editor spike'}
      </button>

      {/* The editor is built here and torn down afterwards; kept out of the
          layout so its height cannot shift the numbers being measured. */}
      <div ref={mountRef} className="sr-only" aria-hidden />

      {result && (
        <>
          <p className="mt-4 text-xs opacity-60">
            {result.words.toLocaleString()} words · {result.paragraphs} paragraphs · {result.aliases} aliases
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <tbody>
                {result.measurements.map((m) => (
                  <tr key={m.label} className="border-b border-current/10 align-top">
                    <td className="py-2 pr-3">
                      {m.label}
                      {m.detail && <span className="block text-xs opacity-60">{m.detail}</span>}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{m.value} {m.unit}</td>
                    <td className="py-2 pr-3 text-xs opacity-60">{m.target}</td>
                    <td className={`py-2 text-xs font-semibold ${
                      m.pass === null || m.pass === undefined ? 'opacity-40'
                        : m.pass ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'}`}>
                      {m.pass === null || m.pass === undefined ? '—' : m.pass ? 'pass' : 'FAIL'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
