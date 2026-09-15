import { useCallback, useEffect, useState } from 'react';
import { useDb } from './DbProvider';
import type { SceneBriefResult } from '../data/briefRepository';
import type { BriefSection } from '../domain/briefBudget';

/**
 * What the model will see — doc 03's inspector.
 *
 * *The writer can see precisely what the model will see, and edit it.* The
 * first half is this panel; editing the brief is a later feature, because an
 * edit has to be stored against something and nothing yet says what. What is
 * shown is the compiled text and, above it, the two things a writer cannot get
 * from the text alone: what the budget cut, and what the book is missing.
 *
 * **The gaps are the point, not the bar chart.** A brief compiled against a
 * book with no chapter summaries looks, as text, like a brief for a book that
 * has only just started. The ladder names every rung that should have had
 * something and did not, and the seed names every entity it could not resolve;
 * this is where a writer sees that list, and it is the same list the gap-fill
 * screen will offer to work through ([D29](../../docs/10-decisions.md)).
 *
 * **It flushes before it compiles.** The prose on screen is up to a debounce
 * ahead of the database, and the ban list reads the current scene's prose —
 * a brief compiled against the previous sentence would ban the wrong phrases.
 *
 * The window is a placeholder until a provider says what the model is. The
 * budget algorithm is the same at every size; a small window simply produces a
 * tighter brief, which is why the smallest option is worth looking at.
 */

const WINDOWS = [
  { value: 8_000, text: '8k — a small local model' },
  { value: 32_000, text: '32k' },
  { value: 128_000, text: '128k' },
  { value: 200_000, text: '200k' },
];

export function SceneBrief({ sceneId }: { sceneId: string }) {
  const db = useDb();
  const [window_, setWindow] = useState(32_000);
  const [result, setResult] = useState<SceneBriefResult | null>(null);
  const [generation, setGeneration] = useState(0);
  const recompile = useCallback(() => setGeneration((g) => g + 1), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [openTrims, setOpenTrims] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      // Before reading anything: the last sentence is still behind the
      // editor's debounce until this returns, and the ban list reads it.
      await db.flushAll();
      if (cancelled) return;
      setBusy(true);
      try {
        const next = await db.brief.compile(sceneId, { window: window_ });
        if (!cancelled) { setResult(next); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [db, sceneId, window_, generation]);

  if (db.state !== 'ready') return null;

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.brief.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  const gaps = result ? gapsOf(result) : [];

  return (
    <section className="mt-6" data-testid="scene-brief">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
          What the model will see
        </h2>
        <select
          aria-label="Context window"
          value={window_}
          onChange={(e) => setWindow(Number(e.target.value))}
          className="rounded border border-current/20 bg-transparent px-1 py-0.5 text-xs">
          {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.text}</option>)}
        </select>
        <button
          onClick={recompile}
          disabled={busy}
          className="text-xs underline opacity-60 disabled:opacity-30">
          Recompile the brief
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs opacity-80">
          The brief could not be compiled: {error}
        </p>
      )}

      {result && (
        <>
          <p className="mt-2 text-xs opacity-60" data-testid="brief-usage">
            {result.brief.used.toLocaleString()} of{' '}
            {result.brief.window.toLocaleString()} tokens, with{' '}
            {result.brief.outputReserve.toLocaleString()} kept back for the answer.
            {result.brief.overflow && (
              <strong className="ml-1 opacity-100" data-testid="brief-overflow">
                {' '}The parts that are never trimmed do not fit on their own — this
                window is too small for this scene.
              </strong>
            )}
          </p>

          {gaps.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs" data-testid="brief-gaps">
              {gaps.map((g) => (
                <li key={g} className="flex gap-1.5">
                  <span aria-hidden="true" className="opacity-40">◦</span>
                  <span className="opacity-70">{g}</span>
                </li>
              ))}
            </ul>
          )}

          <table className="mt-3 w-full text-xs" data-testid="brief-budget">
            <thead className="sr-only">
              <tr><th>Section</th><th>Tokens</th><th>Allowed</th><th>Trimmed</th></tr>
            </thead>
            <tbody>
              {result.brief.sections.filter((s) => s.tokens > 0 || s.trimmed.length > 0).map((s) => (
                <Row
                  key={s.key} section={s}
                  open={openTrims === s.key}
                  onToggle={() => setOpenTrims(openTrims === s.key ? null : s.key)} />
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => setShowText((v) => !v)}
              className="text-xs underline opacity-60">
              {showText ? 'Hide the brief' : 'Show the brief'}
            </button>
            <button onClick={() => void copy()} className="text-xs underline opacity-60">
              {copied ? 'Copied' : 'Copy the brief'}
            </button>
          </div>

          {showText && (
            <pre
              data-testid="brief-text"
              className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg
                         border border-current/15 p-3 font-mono text-xs leading-relaxed">
              {result.brief.text}
            </pre>
          )}
        </>
      )}
    </section>
  );
}

function Row({ section, open, onToggle }: {
  section: BriefSection; open: boolean; onToggle: () => void;
}) {
  const fixed = section.allowed === null;
  const share = fixed || !section.allowed ? 1 : Math.min(1, section.tokens / section.allowed);
  return (
    <>
      <tr data-testid={`brief-section-${section.key}`} className="align-baseline">
        <td className="w-32 py-0.5 pr-2">{section.title}</td>
        <td className="py-0.5 pr-2 text-right tabular-nums">{section.tokens.toLocaleString()}</td>
        <td className="py-0.5 pr-2 tabular-nums opacity-60">
          {fixed ? 'never trimmed' : `of ${section.allowed!.toLocaleString()}`}
        </td>
        <td className="w-full py-0.5">
          {/* Width says how full; the number says how much. Never colour alone. */}
          <div className="h-1.5 w-full rounded bg-current/10" aria-hidden="true">
            <div className="h-1.5 rounded bg-current/40" style={{ width: `${share * 100}%` }} />
          </div>
        </td>
        <td className="py-0.5 pl-2 text-right">
          {section.trimmed.length > 0 && (
            <button
              onClick={onToggle}
              aria-expanded={open}
              className="whitespace-nowrap underline opacity-60">
              {section.trimmed.length} cut
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="pb-1.5 pl-4">
            <ul className="space-y-0.5 opacity-70">
              {section.trimmed.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/** The book's gaps, as sentences, counted rather than listed when there are many. */
function gapsOf(r: SceneBriefResult): string[] {
  const out: string[] = [];
  const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const missing = (rung: 'tail' | 'scene' | 'chapter' | 'part') =>
    r.ladder.missing.filter((g) => g.rung === rung);

  if (missing('tail').length) out.push('The scene before this one has no prose yet, so nothing carries across the seam.');
  const scenes = missing('scene');
  if (scenes.length) out.push(`${count(scenes.length, 'A recent scene has', 'recent scenes have')} no summary.`);
  const chapters = missing('chapter');
  if (chapters.length) out.push(`${count(chapters.length, 'A chapter in this act has', 'chapters in this act have')} no summary.`);
  const parts = missing('part');
  if (parts.length) out.push(`${count(parts.length, 'An earlier act has', 'earlier acts have')} no summary.`);
  if (r.dossiered.unresolved.length) {
    out.push(`${count(r.dossiered.unresolved.length, 'One reference', 'references')} could not be resolved to a codex entry.`);
  }
  if (r.dossiered.beats.length === 0) out.push('No beat: the scene has nothing to aim at.');
  if (!r.dossiered.scene.povEntityId) out.push('No point of view is set.');
  return out;
}
