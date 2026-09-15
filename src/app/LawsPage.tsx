import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import type { Entity } from '../data/codexRepository';
import type { Law, LawCategory, LawScopeType, LawSeverity } from '../data/lawsRepository';

/**
 * The laws — what the model must, should and would rather do.
 *
 * Doc 04 in one screen. Every law is a scoped, typed constraint, and the two
 * things the writer decides here are exactly the two the compiler reads: how
 * hard it binds (`must` is never trimmed from a brief; `should` and `prefer`
 * give way when the window is small) and where it applies. A law for the whole
 * project is in every brief. A law tied to a character travels with that
 * character's entry, and one tied to the point of view fires only in scenes
 * told through their eyes — which is how a voice law for Kaelen stays out of
 * a scene he is not in ([doc 04](../../docs/04-laws-engine.md)).
 *
 * The hard floor is listed and not editable. A writer should be able to read
 * what the tool will not do; that is different from being able to change it
 * ([D3](../../docs/10-decisions.md)).
 *
 * *A law being violated constantly is often a law that's wrong, and the tool
 * should make it easy to say so.* So editing is in place and deleting is one
 * step: a law is a sentence, and a wrong sentence should cost one click.
 */

const CATEGORIES: { value: LawCategory; text: string; what: string }[] = [
  { value: 'content', text: 'content', what: 'your own ceiling — what stays off the page' },
  { value: 'canon', text: 'canon', what: 'how the world works, and what must not be contradicted' },
  { value: 'style', text: 'style', what: 'the prose — tense, spelling, punctuation, habits to avoid' },
  { value: 'voice', text: 'voice', what: 'how one character talks and thinks' },
  { value: 'structure', text: 'structure', what: 'shape — scene length, chapter endings, one POV a scene' },
  { value: 'ip', text: 'ip', what: 'what not to imitate or reproduce' },
];
const SEVERITIES: { value: LawSeverity; text: string }[] = [
  { value: 'must', text: 'must — never trimmed from a brief' },
  { value: 'should', text: 'should' },
  { value: 'prefer', text: 'prefer' },
];

type ScopeChoice = 'project' | `entity:${string}` | `pov:${string}`;
const scopeChoice = (law: Pick<Law, 'scopeType' | 'scopeId'>): ScopeChoice =>
  law.scopeType === 'entity' && law.scopeId ? `entity:${law.scopeId}`
    : law.scopeType === 'pov' && law.scopeId ? `pov:${law.scopeId}`
      : 'project';
const fromChoice = (c: ScopeChoice): { scopeType: LawScopeType; scopeId: string | null } => {
  if (c.startsWith('entity:')) return { scopeType: 'entity', scopeId: c.slice(7) };
  if (c.startsWith('pov:')) return { scopeType: 'pov', scopeId: c.slice(4) };
  return { scopeType: 'project', scopeId: null };
};

export function LawsPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [laws, setLaws] = useState<Law[]>([]);
  const [people, setPeople] = useState<Entity[]>([]);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [rule, setRule] = useState('');
  const [category, setCategory] = useState<LawCategory>('style');
  const [severity, setSeverity] = useState<LawSeverity>('must');
  const [scope, setScope] = useState<ScopeChoice>('project');

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [list, entities] = await Promise.all([
        db.laws.list(projectId), db.codex.listEntities(projectId),
      ]);
      if (cancelled) return;
      setLaws(list);
      setPeople(entities.filter((e) => e.typeKey === 'character'));
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  const act = useCallback(async (job: () => Promise<string | void>) => {
    setBusy(true);
    try { setNote((await job()) ?? null); }
    catch (e) { setNote((e as Error).message ?? String(e)); }
    finally { setBusy(false); reload(); }
  }, [reload]);

  if (db.state !== 'ready') return null;

  const add = () => void act(async () => {
    await db.laws.create(projectId, { title, ruleText: rule, category, severity, ...fromChoice(scope) });
    setTitle('');
    setRule('');
    return `Added. It is in every brief ${scope === 'project' ? 'for this project' : 'it applies to'} from now on.`;
  });

  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? 'a codex entry';
  const scopeText = (law: Law) =>
    law.scopeType === 'project' ? 'whole project'
      : law.scopeType === 'entity' ? `when ${nameOf(law.scopeId)} is in the scene`
        : law.scopeType === 'pov' ? `when ${nameOf(law.scopeId)} is the point of view`
          : `${law.scopeType} scope`;

  const grouped = CATEGORIES
    .map((c) => ({ ...c, laws: laws.filter((l) => l.category === c.value) }))
    .filter((c) => c.laws.length > 0);
  const other = laws.filter((l) => !CATEGORIES.some((c) => c.value === l.category));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="laws">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">← Manuscript</Link>
      <h1 className="mt-4 text-xl font-semibold">Laws</h1>
      <p className="mt-2 text-sm opacity-70">
        Rules the model follows when it writes for this book. A <em>must</em> is never
        trimmed from a brief, however small the model&rsquo;s window; a <em>should</em>
        or <em>prefer</em> gives way first. A law for the whole project is in every
        brief; one tied to a character goes only where that character goes.
      </p>

      {note && <p aria-live="polite" role="status" className="mt-3 text-sm opacity-80">{note}</p>}

      <section className="mt-6 rounded-lg border border-current/15 p-3" data-testid="new-law">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">Add a law</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
          <label className="sr-only" htmlFor="law-title">Law title</label>
          <input
            id="law-title" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="No em dashes"
            className="min-w-0 rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm" />
          <select
            aria-label="Category" value={category}
            onChange={(e) => setCategory(e.target.value as LawCategory)}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.text} — {c.what}</option>)}
          </select>
        </div>
        <label className="sr-only" htmlFor="law-rule">The rule, as an instruction</label>
        <textarea
          id="law-rule" rows={2} value={rule} onChange={(e) => setRule(e.target.value)}
          placeholder="Do not use em dashes anywhere. Use a comma, a full stop, or a new sentence."
          className="mt-2 w-full rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Severity" value={severity}
            onChange={(e) => setSeverity(e.target.value as LawSeverity)}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1 text-xs">
            {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.text}</option>)}
          </select>
          <select
            aria-label="Where it applies" value={scope}
            onChange={(e) => setScope(e.target.value as ScopeChoice)}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1 text-xs">
            <option value="project">the whole project</option>
            {people.map((p) => <option key={`e${p.id}`} value={`entity:${p.id}`}>when {p.name} is in the scene</option>)}
            {people.map((p) => <option key={`p${p.id}`} value={`pov:${p.id}`}>when {p.name} is the point of view</option>)}
          </select>
          <span className="flex-1" />
          <button
            disabled={busy || !title.trim() || !rule.trim()}
            onClick={add}
            className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm font-medium
                       disabled:opacity-50">
            Add the law
          </button>
        </div>
      </section>

      {laws.length === 0 && (
        <p className="mt-6 text-sm opacity-60">
          No laws yet. Importing a house-style file offers one per line; or add the first one above.
        </p>
      )}

      {[...grouped, ...(other.length ? [{ value: 'other' as const, text: 'other', what: '', laws: other }] : [])]
        .map((group) => (
          <section key={group.value} className="mt-8" data-category={group.value}>
            <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
              {group.text}{group.what ? <span className="ml-2 font-normal normal-case opacity-70">— {group.what}</span> : null}
            </h2>
            <ul className="mt-2 space-y-1">
              {group.laws.map((law) => (
                <li
                  key={law.id} data-law={law.id} data-active={law.active ? 'true' : 'false'}
                  className={`rounded-lg px-2 py-2 hover:bg-current/5 ${law.active ? '' : 'opacity-50'}`}>
                  {editing === law.id
                    ? <Editor law={law} people={people} busy={busy} onDone={() => setEditing(null)}
                      onSave={(patch) => void act(async () => {
                        await db.laws.update(law.id, patch);
                        setEditing(null);
                        return 'Saved.';
                      })} />
                    : (
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium">{law.title}</span>
                        <span className="rounded-full border border-current/25 px-1.5 text-xs opacity-70">
                          {law.severity}
                        </span>
                        {law.isSystem && (
                          <span className="rounded-full border border-current/25 px-1.5 text-xs opacity-70"
                            title="The hard floor: listed so you can read it, not editable">
                            hard floor
                          </span>
                        )}
                        <span className="text-xs opacity-50">{scopeText(law)}</span>
                        <span className="flex-1" />
                        {!law.isSystem && (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => void act(async () => {
                                await db.laws.update(law.id, { active: !law.active });
                                return law.active ? 'Switched off. It stays here; it is just not in the brief.' : 'Switched on.';
                              })}
                              aria-pressed={law.active}
                              className="text-xs underline opacity-60 disabled:opacity-30">
                              {law.active ? 'switch off' : 'switch on'}
                            </button>
                            <button disabled={busy} onClick={() => setEditing(law.id)}
                              className="text-xs underline opacity-60 disabled:opacity-30">
                              edit
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => void act(async () => { await db.laws.remove(law.id); return 'Removed.'; })}
                              className="text-xs underline opacity-50 disabled:opacity-30">
                              delete
                            </button>
                          </>
                        )}
                        <p className="w-full whitespace-pre-wrap text-sm opacity-80">{law.ruleText}</p>
                        {(law.examplesGood || law.examplesBad) && (
                          <p className="w-full text-xs opacity-60">
                            {law.examplesGood && <>Good: {law.examplesGood} </>}
                            {law.examplesBad && <>Bad: {law.examplesBad}</>}
                          </p>
                        )}
                      </div>
                    )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function Editor({ law, people, busy, onSave, onDone }: {
  law: Law; people: Entity[]; busy: boolean;
  onSave: (patch: {
    title: string; ruleText: string; category: LawCategory; severity: LawSeverity;
    scopeType: LawScopeType; scopeId: string | null; examplesGood: string | null; examplesBad: string | null;
  }) => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(law.title);
  const [rule, setRule] = useState(law.ruleText);
  const [category, setCategory] = useState<LawCategory>(law.category);
  const [severity, setSeverity] = useState<LawSeverity>(law.severity);
  const [scope, setScope] = useState<ScopeChoice>(scopeChoice(law));
  const [good, setGood] = useState(law.examplesGood ?? '');
  const [bad, setBad] = useState(law.examplesBad ?? '');
  return (
    <div className="space-y-2" data-testid="law-editor">
      <label className="sr-only" htmlFor={`title-${law.id}`}>Title</label>
      <input id={`title-${law.id}`} value={title} onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm" />
      <label className="sr-only" htmlFor={`rule-${law.id}`}>Rule</label>
      <textarea id={`rule-${law.id}`} rows={3} value={rule} onChange={(e) => setRule(e.target.value)}
        className="w-full rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as LawCategory)}
          className="rounded border border-current/20 bg-transparent px-1 py-0.5">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.text}</option>)}
        </select>
        <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as LawSeverity)}
          className="rounded border border-current/20 bg-transparent px-1 py-0.5">
          {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.value}</option>)}
        </select>
        <select aria-label="Where it applies" value={scope} onChange={(e) => setScope(e.target.value as ScopeChoice)}
          className="rounded border border-current/20 bg-transparent px-1 py-0.5">
          <option value="project">the whole project</option>
          {people.map((p) => <option key={`e${p.id}`} value={`entity:${p.id}`}>when {p.name} is in the scene</option>)}
          {people.map((p) => <option key={`p${p.id}`} value={`pov:${p.id}`}>when {p.name} is the point of view</option>)}
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label="A good example" value={good} onChange={(e) => setGood(e.target.value)} placeholder="Good: …"
          className="rounded-lg border border-current/20 bg-transparent px-2.5 py-1 text-xs" />
        <input aria-label="A bad example" value={bad} onChange={(e) => setBad(e.target.value)} placeholder="Bad: …"
          className="rounded-lg border border-current/20 bg-transparent px-2.5 py-1 text-xs" />
      </div>
      <div className="flex gap-3">
        <button
          disabled={busy || !title.trim() || !rule.trim()}
          onClick={() => onSave({
            title, ruleText: rule, category, severity, ...fromChoice(scope),
            examplesGood: good.trim() || null, examplesBad: bad.trim() || null,
          })}
          className="rounded-lg border border-current/20 bg-current/10 px-3 py-1 text-xs font-medium disabled:opacity-50">
          Save
        </button>
        <button onClick={onDone} className="text-xs underline opacity-60">Cancel</button>
      </div>
    </div>
  );
}
