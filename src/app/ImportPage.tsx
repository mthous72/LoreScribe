import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import { ACCEPTED, parseFiles, type ReadResult } from '../import/read';
import { walk, type SourceDoc } from '../import/source';
import {
  suggestAll, nameKey, type Destination, type LawCategory, type SuggestContext,
} from '../import/plan';
import {
  decisionKey, type Decisions, type ImportRun, type ProposalRow,
} from '../data/importRepository';

/**
 * Bringing a story bible in.
 *
 * The screen is arranged around one promise: you will see everything that is
 * about to happen, and nothing will happen until you say so. That is why it is
 * three steps rather than a button — read, map, review — and why each of them
 * is undoable, including the last.
 *
 * Nothing on this screen guesses silently. Every proposed destination shows the
 * rule that produced it, in the writer's terms, and anything no rule recognised
 * says so and does nothing. A writer who disagrees with a row changes one
 * dropdown; a writer who disagrees with the whole thing loses nothing, because
 * a run that is never applied wrote nothing but proposals.
 */

type Step = 'choose' | 'map' | 'review' | 'done';

const DESTINATIONS = (types: string[]): { value: string; text: string }[] => [
  { value: 'skip', text: 'Skip — do nothing with it' },
  ...types.map((t) => ({ value: `entity:${t}`, text: `Codex entry — ${t}` })),
  { value: 'knowledge', text: 'Facts, from the table in it' },
  { value: 'scene', text: 'A scene, with this prose' },
  { value: 'plan', text: 'The plan — acts, planned scenes and their beats' },
  { value: 'law:style', text: 'Laws — style, one per line' },
  { value: 'law:canon', text: 'Laws — canon, one per line' },
  { value: 'law:content', text: 'Laws — content, one per line' },
  { value: 'note', text: 'A note' },
];

const toDestination = (value: string): Destination => {
  if (value.startsWith('entity:')) return { kind: 'entity', typeKey: value.slice(7) };
  if (value === 'knowledge') return { kind: 'knowledge', factColumn: 0 };
  if (value === 'scene') return { kind: 'scene' };
  if (value === 'plan') return { kind: 'plan' };
  if (value.startsWith('law:')) return { kind: 'law', category: value.slice(4) as LawCategory };
  if (value === 'note') return { kind: 'note' };
  return { kind: 'skip' };
};
const fromDestination = (d: Destination): string =>
  (d.kind === 'entity' ? `entity:${d.typeKey}` : d.kind === 'law' ? `law:${d.category}` : d.kind);

export function ImportPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [step, setStep] = useState<Step>('choose');
  const [read, setRead] = useState<ReadResult | null>(null);
  const [context, setContext] = useState<SuggestContext | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ proposalId: string; reason: string }[]>([]);
  const [generation, setGeneration] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [types, entities, previous] = await Promise.all([
        db.codex.listTypes(projectId),
        db.codex.listEntities(projectId),
        db.imports.listRuns(projectId),
      ]);
      if (cancelled) return;
      const existing = new Map(entities.map((e) =>
        [nameKey(e.name), { id: e.id, name: e.name, typeKey: e.typeKey }]));
      setContext({ existing, types: new Set(types.map((t) => t.key)) });
      setRuns(previous);
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  const typeKeys = useMemo(() => [...(context?.types ?? [])].sort(), [context]);
  const suggestions = useMemo(
    () => (read && context ? suggestAll(read.docs, context) : []), [read, context]);

  // The writer's choice where they made one, the rule's where they did not.
  const chosen = useCallback((docPath: string, nodeId: string, fallback: Destination) =>
    decisions[decisionKey(docPath, nodeId)] ?? fallback, [decisions]);

  const take = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const result = await parseFiles([...files]);
      setRead(result);
      setDecisions({});
      setStep('map');
      setNote(result.docs.length
        ? null
        : 'Nothing in that selection could be read. Markdown, text, Word, JSON and CSV.');
    } finally { setBusy(false); }
  }, []);

  const stage = useCallback(async () => {
    if (db.state !== 'ready' || !read) return;
    setBusy(true);
    try {
      const full: Decisions = {};
      for (const s of suggestions) {
        full[decisionKey(s.docPath, s.nodeId)] = chosen(s.docPath, s.nodeId, s.destination);
      }
      const { runId: id } = await db.imports.stage(projectId, read.docs, full);
      await db.imports.acceptAll(id);
      setRunId(id);
      setProposals(await db.imports.listProposals(id));
      setStep('review');
    } finally { setBusy(false); }
  }, [db, projectId, read, suggestions, chosen]);

  const apply = useCallback(async () => {
    if (db.state !== 'ready' || !runId) return;
    setBusy(true);
    try {
      const result = await db.imports.apply(projectId, runId);
      setFailures(result.failed);
      setNote(`${result.applied} applied.`);
      setStep('done');
      setGeneration((g) => g + 1);
    } finally { setBusy(false); }
  }, [db, projectId, runId]);

  const discard = useCallback(async () => {
    if (db.state !== 'ready' || !runId) return;
    await db.imports.abandon(runId);
    setRunId(null);
    setProposals([]);
    setStep('choose');
    setRead(null);
    setNote('Discarded. Nothing was written.');
    setGeneration((g) => g + 1);
  }, [db, runId]);

  const undo = useCallback(async (id: string) => {
    if (db.state !== 'ready') return;
    setBusy(true);
    try {
      const { reverted } = await db.imports.undo(id);
      setNote(`Taken back out — ${reverted} row${reverted === 1 ? '' : 's'}.`);
      setStep('choose');
      setRead(null);
      setRunId(null);
      setGeneration((g) => g + 1);
    } finally { setBusy(false); }
  }, [db]);

  if (db.state !== 'ready') return null;

  const accepted = proposals.filter((p) => p.status === 'accepted');

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">
        ← Manuscript
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Bring in a bible</h1>
      <p className="mt-2 text-sm opacity-70">
        Markdown, plain text, Word, JSON or CSV. You will see everything that is
        about to happen before any of it does, and you can take it back
        afterwards.
      </p>

      {note && <p aria-live="polite" className="mt-3 text-sm opacity-80">{note}</p>}

      {step === 'choose' && (
        <div className="mt-5 flex flex-wrap gap-3">
          <input
            ref={fileInput} type="file" multiple accept={ACCEPTED} className="hidden"
            aria-label="Choose files"
            onChange={(e) => void take(e.target.files)}
          />
          <input
            ref={folderInput} type="file" className="hidden"
            aria-label="Choose a folder"
            // A bible is usually a folder. Not on every browser, which is why
            // the file picker beside it is the one that always works.
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => void take(e.target.files)}
          />
          <button
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                       font-medium disabled:opacity-50">
            Choose files
          </button>
          <button
            disabled={busy}
            onClick={() => folderInput.current?.click()}
            className="rounded-lg border border-current/20 px-4 py-2 text-sm disabled:opacity-50">
            Choose a folder
          </button>
        </div>
      )}

      {step === 'map' && read && (
        <>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-3 text-sm">
            <span className="font-medium">
              {read.docs.length} file{read.docs.length === 1 ? '' : 's'} read
            </span>
            <span className="opacity-60">{suggestions.length} things found</span>
          </div>

          {read.skipped.length > 0 && (
            <ul className="mt-2 text-xs opacity-60">
              {read.skipped.map((s) => (
                <li key={s.path}>Could not read {s.path} — {s.reason}</li>
              ))}
            </ul>
          )}

          <ol className="mt-5 space-y-5">
            {read.docs.map((doc) => (
              <li key={doc.path}>
                <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
                  {doc.path}
                </h2>
                <ul className="mt-1 space-y-2">
                  {suggestions.filter((s) => s.docPath === doc.path).map((s) => {
                    const key = decisionKey(s.docPath, s.nodeId);
                    const value = fromDestination(chosen(s.docPath, s.nodeId, s.destination));
                    return (
                      <li key={key} data-suggestion={key} className="rounded-lg px-2 py-1.5 hover:bg-current/5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm">{s.label}</span>
                          {s.matchesEntityId && (
                            <span className="shrink-0 rounded-full border border-current/20 px-1.5 text-xs opacity-60">
                              already in your codex
                            </span>
                          )}
                          <select
                            aria-label={`Where ${s.label} goes`}
                            value={value}
                            onChange={(e) => setDecisions((d) =>
                              ({ ...d, [key]: toDestination(e.target.value) }))}
                            className="max-w-[16rem] rounded-lg border border-current/20 bg-transparent px-2 py-1 text-xs">
                            {DESTINATIONS(typeKeys).map((o) => (
                              <option key={o.value} value={o.value}>{o.text}</option>
                            ))}
                          </select>
                        </div>
                        {/* The rule, in the writer's terms. A suggestion nobody
                            can audit is one they accept blindly or reject
                            wholesale, and both make the review theatre. */}
                        <p className="mt-0.5 text-xs opacity-50">{s.reason}</p>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              disabled={busy}
              onClick={() => void stage()}
              className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                         font-medium disabled:opacity-50">
              Stage these changes
            </button>
            <button
              disabled={busy}
              onClick={() => { setStep('choose'); setRead(null); }}
              className="rounded-lg border border-current/20 px-4 py-2 text-sm disabled:opacity-50">
              Start over
            </button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          <p className="mt-5 text-sm">
            <strong>{accepted.length}</strong> change
            {accepted.length === 1 ? '' : 's'} ready. Nothing has been written yet.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {proposals.map((p) => (
              <li
                key={p.id}
                data-proposal={p.targetTable}
                className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1
                            ${p.status === 'rejected' ? 'opacity-40' : ''}`}>
                <span className="shrink-0 text-xs uppercase tracking-wide opacity-50">
                  {p.targetTable.replace('_', ' ')}
                </span>
                <span className="min-w-0 flex-1 truncate">{describe(p)}</span>
                <button
                  onClick={() => void (async () => {
                    const next = p.status === 'rejected' ? 'accepted' : 'rejected';
                    await db.imports.setStatus([p.id], next);
                    setProposals(await db.imports.listProposals(p.runId));
                  })()}
                  className="shrink-0 text-xs underline opacity-60">
                  {p.status === 'rejected' ? 'put back' : 'leave out'}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              disabled={busy || accepted.length === 0}
              onClick={() => void apply()}
              className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                         font-medium disabled:opacity-50">
              Apply {accepted.length}
            </button>
            <button
              disabled={busy}
              onClick={() => void discard()}
              className="rounded-lg border border-current/20 px-4 py-2 text-sm disabled:opacity-50">
              Discard
            </button>
          </div>
        </>
      )}

      {step === 'done' && failures.length > 0 && (
        <>
          <p className="mt-4 text-sm">
            {failures.length} could not be applied. Named rather than dropped —
            a count with no list gives you no way to find them.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs opacity-70">
            {failures.map((f) => <li key={f.proposalId}>{f.reason}</li>)}
          </ul>
        </>
      )}

      {runs.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
            Imports so far
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {runs.map((run) => (
              <li
                key={run.id}
                data-run-status={run.status}
                className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1">
                <span className="min-w-0 flex-1 truncate">
                  {new Date(run.createdAt).toLocaleString()} · {run.status}
                </span>
                <span className="shrink-0 text-xs tabular-nums opacity-50">
                  {Object.entries(run.counts).map(([k, n]) => `${n} ${k}`).join(', ')}
                </span>
                {run.status === 'applied' && (
                  <button
                    disabled={busy}
                    onClick={() => void undo(run.id)}
                    className="shrink-0 text-xs underline opacity-70 disabled:opacity-30">
                    take it back out
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** What a proposal will do, in one line a writer can check. */
function describe(p: ProposalRow): string {
  const payload = p.payload as Record<string, string>;
  if (p.targetTable === 'entity') return payload.name ?? '';
  if (p.targetTable === 'fact') return payload.statement ?? '';
  if (p.targetTable === 'fact_knowledge') {
    return `${payload.entityName} — ${payload.belief}${payload.learnedHow ? ` (${payload.learnedHow})` : ''}`;
  }
  if (p.targetTable === 'law') return `${payload.category}: ${payload.ruleText ?? payload.title}`;
  if (p.targetTable === 'plan') {
    type Parts = { title: string | null; sections: { beats: unknown[] }[] }[];
    const parts = (p.payload as { parts?: Parts }).parts ?? [];
    const sections = parts.flatMap((x) => x.sections);
    const beats = sections.reduce((n, x) => n + x.beats.length, 0);
    const acts = parts.filter((x) => x.title !== null).length;
    return `${payload.arcName}: ${acts ? `${acts} act${acts === 1 ? '' : 's'}, ` : ''}`
      + `${sections.length} planned scene${sections.length === 1 ? '' : 's'}, ${beats} beat${beats === 1 ? '' : 's'}`;
  }
  return payload.title ?? '';
}

/** The count a reader of the mapping step wants: how many nodes came out of a document. */
export const nodeCount = (doc: SourceDoc): number => [...walk(doc.root)].length;
