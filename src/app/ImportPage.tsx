import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import { ACCEPTED, parseFiles, type ReadResult } from '../import/read';
import { walk, type SourceDoc } from '../import/source';
import {
  suggestAll, nameKey, type Destination, type LawCategory, type SuggestContext,
} from '../import/plan';
import {
  EDITABLE, decisionKey, type Decisions, type ImportRun, type ProposalRow,
} from '../data/importRepository';
import type { ExtractEvent } from '../ai/extract';
import type { ExtractTypes } from '../domain/extract';
import { NoModelError, SpendCapError } from '../ai/roles';
import { explainProviderError } from '../ai/explain';
import { usd } from '../domain/spend';
import type { EntityType } from '../data/codexRepository';

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
 *
 * Two lanes feed the same review. The rules are free and legible and remain
 * the default. **The model** — the `extract` role, the cheap one — reads the
 * files and proposes who is in them, what is true, and what the writer's rules
 * are, each with the words it read; a proposal it cannot trace to the file is
 * shown as that and never accepted for the writer. Either lane's proposal can
 * be edited before it is applied, because a wrong type is one field, not a
 * reason to start again by hand.
 */

type Step = 'choose' | 'map' | 'review' | 'done';
type Progress = { total: number; done: number; label: string; found: number; tokens: number };
type Finished = Extract<ExtractEvent, { kind: 'done' }>;

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
  const [types, setTypes] = useState<EntityType[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [needsModel, setNeedsModel] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
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
      setTypes(types);
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

  // A read in flight belongs to this screen.
  useEffect(() => () => abort.current?.abort(), []);

  const refresh = useCallback(async (id: string) => {
    if (db.state !== 'ready') return;
    setProposals(await db.imports.listProposals(id));
  }, [db]);

  /** The extract role reads every file; what it finds lands in the same review. */
  const askModel = useCallback(async () => {
    if (db.state !== 'ready' || !read || !context) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setNote(null);
    setNeedsModel(false);
    setFinished(null);
    const forModel: ExtractTypes = {
      types: types.filter((t) => context.types.has(t.key)).map((t) => ({ key: t.key, label: t.label })),
      existing: context.existing,
    };
    try {
      for await (const ev of db.extractor.extract(projectId, read.docs, forModel, ctl.signal)) {
        if (ev.kind === 'plan') {
          setProgress({ total: ev.chunks, done: 0, label: '', found: 0, tokens: ev.tokens });
        } else if (ev.kind === 'chunk') {
          setProgress((p) => p && {
            ...p, done: ev.index + 1, label: ev.label, found: p.found + ev.proposals,
          });
        } else {
          setFinished(ev);
          if (ev.runId) {
            setRunId(ev.runId);
            await refresh(ev.runId);
            setStep('review');
          } else {
            setNote('The model proposed nothing it could point to in these files.');
          }
        }
      }
    } catch (e) {
      if (e instanceof NoModelError) { setNeedsModel(true); setNote(e.message); }
      else if (e instanceof SpendCapError) setNote(e.message);
      else setNote(explainProviderError(e));
    } finally {
      setBusy(false);
      setProgress(null);
      abort.current = null;
      setGeneration((g) => g + 1);
    }
  }, [db, projectId, read, context, types, refresh]);

  const take = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const result = await parseFiles([...files]);
      setRead(result);
      setDecisions({});
      setStep('map');
      setFinished(null);
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
  const unverified = proposals.filter((p) => p.status === 'pending' && !p.evidenceVerified);

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

      {note && (
        <p aria-live="polite" role="status" className="mt-3 text-sm opacity-80">
          {note}
          {needsModel && (
            <>
              {' '}
              <Link to={`/project/${projectId}/providers`} className="underline">Providers →</Link>
            </>
          )}
        </p>
      )}

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

          <section className="mt-6 rounded-lg border border-current/15 p-3" data-testid="ask-model">
            <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">Or let the model read them</h2>
            <p className="mt-1 text-xs opacity-70">
              The extract model reads each file and proposes the people, places, facts and rules in it,
              quoting the words it read. Anything it cannot point to in the file is shown as such and
              left for you to decide. {planLine(read, db.extractor.plan(read.docs).length)}
            </p>
            {progress && (
              <p className="mt-2 text-xs" data-testid="extract-progress" aria-live="polite">
                Reading {progress.done} of {progress.total}
                {progress.label ? ` — ${progress.label}` : ''} · {progress.found} found so far
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-3">
              {progress
                ? (
                  <button onClick={() => abort.current?.abort()}
                    className="rounded-lg border border-current/20 px-4 py-2 text-sm">
                    Stop
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => void askModel()}
                    className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                               font-medium disabled:opacity-50">
                    Let the model read them
                  </button>
                )}
            </div>
          </section>

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
            {unverified.length > 0 && (
              <> {unverified.length} more could not be traced to the files and {unverified.length === 1 ? 'waits' : 'wait'} for you.</>
            )}
          </p>
          {finished && <ModelSummary finished={finished} />}
          <ul className="mt-3 space-y-1 text-sm">
            {proposals.map((p) => (
              <li
                key={p.id}
                data-proposal={p.targetTable}
                data-status={p.status}
                data-verified={p.evidenceVerified ? 'true' : 'false'}
                className={`rounded-lg px-2 py-1
                            ${p.status === 'rejected' || (p.status === 'pending' && !p.evidenceVerified) ? 'opacity-50' : ''}`}>
                {editing === p.id
                  ? (
                    <ProposalEditor
                      proposal={p} types={types} busy={busy}
                      onDone={() => setEditing(null)}
                      onSave={(patch) => void (async () => {
                        try {
                          await db.imports.edit(p.id, patch);
                          setEditing(null);
                          setNote(null);
                        } catch (e) {
                          setNote((e as Error).message ?? String(e));
                        }
                        await refresh(p.runId);
                      })()} />
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="shrink-0 text-xs uppercase tracking-wide opacity-50">
                          {p.targetTable.replace('_', ' ')}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{describe(p)}</span>
                        {p.op === 'update' && (
                          <span className="shrink-0 rounded-full border border-current/20 px-1.5 text-xs opacity-60">
                            already in your codex
                          </span>
                        )}
                        {p.confidence !== null && (
                          <span className="shrink-0 text-xs tabular-nums opacity-50" title="the model's own confidence">
                            {Math.round(p.confidence * 100)}%
                          </span>
                        )}
                        {!p.evidenceVerified && (
                          <span className="shrink-0 rounded-full border border-current/30 px-1.5 text-xs" data-testid="unverified">
                            could not be traced to the file
                          </span>
                        )}
                        {p.status === 'pending' && !p.evidenceVerified && (
                          <button
                            onClick={() => void (async () => {
                              await db.imports.setStatus([p.id], 'accepted');
                              await refresh(p.runId);
                            })()}
                            className="shrink-0 text-xs underline opacity-70">
                            accept anyway
                          </button>
                        )}
                        {(EDITABLE[p.targetTable]?.length ?? 0) > 0 && p.status !== 'rejected' && (
                          <button onClick={() => setEditing(p.id)} className="shrink-0 text-xs underline opacity-60">
                            edit
                          </button>
                        )}
                        <button
                          onClick={() => void (async () => {
                            const next = p.status === 'rejected' ? 'accepted' : 'rejected';
                            await db.imports.setStatus([p.id], next);
                            await refresh(p.runId);
                          })()}
                          className="shrink-0 text-xs underline opacity-60">
                          {p.status === 'rejected' ? 'put back' : 'leave out'}
                        </button>
                      </div>
                      {(p.rationale || p.evidenceQuote) && (
                        <p className="mt-0.5 text-xs opacity-50">
                          {p.rationale}
                          {p.evidenceQuote && <> · <q>{p.evidenceQuote}</q></>}
                        </p>
                      )}
                    </>
                  )}
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
                {run.status === 'staged' && (
                  <button
                    disabled={busy}
                    onClick={() => void (async () => {
                      setRunId(run.id);
                      setFinished(null);
                      await refresh(run.id);
                      setStep('review');
                    })()}
                    className="shrink-0 text-xs underline opacity-70 disabled:opacity-30">
                    review
                  </button>
                )}
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

/** What one pass would send, said before it is sent. */
function planLine(read: ReadResult, calls: number): string {
  const chars = read.docs.reduce(
    (n, d) => n + [...walk(d.root)].reduce((m, { node }) => m + node.text.length, 0), 0);
  const tokens = Math.ceil(chars / 4);
  const size = tokens >= 1000 ? `about ${Math.round(tokens / 1000)} thousand tokens` : `about ${tokens} tokens`;
  return `${read.docs.length} file${read.docs.length === 1 ? '' : 's'} in ${calls} call${calls === 1 ? '' : 's'}, ${size} to the extract model.`;
}

/** What the model pass did, in one paragraph, problems named rather than counted. */
function ModelSummary({ finished }: { finished: Finished }) {
  const { proposals, unverified, dropped, problems, costUsd } = finished;
  return (
    <div className="mt-2 text-xs opacity-70" data-testid="model-summary">
      <p>
        The model proposed {proposals} thing{proposals === 1 ? '' : 's'} for {usd(costUsd)}
        {unverified > 0 && <>, {unverified} of them without words it could point to</>}
        {dropped.length > 0 && (
          <>, and {dropped.length} more it filed under a type this project does not have</>
        )}.
      </p>
      {dropped.length > 0 && (
        <ul className="mt-0.5 list-disc pl-4">
          {dropped.slice(0, 8).map((d, i) => <li key={i}>{d.what}: {d.reason}</li>)}
        </ul>
      )}
      {problems.length > 0 && (
        <ul className="mt-0.5 list-disc pl-4">
          {problems.map((p, i) => (
            <li key={i}>{p.label}: {p.state}{p.detail ? ` — ${p.detail}` : ''}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const BELIEFS = ['knows', 'suspects', 'believes_false', 'denies'];
const LAW_CATEGORIES = ['style', 'canon', 'content'];

/** The fields `EDITABLE` allows for the proposal's table, as inputs. */
function ProposalEditor({ proposal, types, busy, onSave, onDone }: {
  proposal: ProposalRow; types: EntityType[]; busy: boolean;
  onSave: (patch: Record<string, unknown>) => void; onDone: () => void;
}) {
  const fields = EDITABLE[proposal.targetTable] ?? [];
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f, String(proposal.payload[f] ?? '')])));
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const choices = (key: string): string[] | null =>
    key === 'typeKey' ? types.map((t) => t.key) : key === 'belief' ? BELIEFS : key === 'category' ? LAW_CATEGORIES : null;
  const wide = (key: string) => key === 'statement' || key === 'ruleText' || key === 'summary';
  return (
    <div className="space-y-2" data-testid="proposal-editor">
      {fields.map((key) => {
        const options = choices(key);
        const id = `edit-${proposal.id}-${key}`;
        return (
          <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor={id} className="w-20 shrink-0 opacity-60">{labelOf(key)}</label>
            {options
              ? (
                <select id={id} value={draft[key] ?? ''} onChange={(e) => set(key, e.target.value)}
                  className="rounded border border-current/20 bg-transparent px-1 py-0.5">
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : wide(key)
                ? (
                  <textarea id={id} rows={2} value={draft[key] ?? ''} onChange={(e) => set(key, e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm" />
                ) : (
                  <input id={id} value={draft[key] ?? ''} onChange={(e) => set(key, e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm" />
                )}
          </div>
        );
      })}
      <div className="flex gap-3">
        <button
          disabled={busy}
          onClick={() => onSave(Object.fromEntries(fields.filter((f) => draft[f] !== String(proposal.payload[f] ?? ''))
            .map((f) => [f, draft[f]])))}
          className="rounded-lg border border-current/20 bg-current/10 px-3 py-1 text-xs font-medium disabled:opacity-50">
          Save
        </button>
        <button onClick={onDone} className="text-xs underline opacity-60">Cancel</button>
      </div>
    </div>
  );
}

const labelOf = (key: string): string => ({
  typeKey: 'type', ruleText: 'rule', learnedHow: 'how known', arcName: 'arc', entityName: 'entity',
} as Record<string, string>)[key] ?? key;

/** The count a reader of the mapping step wants: how many nodes came out of a document. */
export const nodeCount = (doc: SourceDoc): number => [...walk(doc.root)].length;
