import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import {
  factVisibilityAt, negativeConstraints, continuityProblems,
  type FactStatus, type FactVisibility,
} from '../domain/factVisibility';
import type { Fact, FactConflict, KnowledgeRow, Belief } from '../data/factsRepository';
import type { Entity } from '../data/codexRepository';
import type { SceneSummary } from '../data/manuscriptRepository';

/**
 * The facts screen — what is true, when it became true, and who knows.
 *
 * A list of claims would not have needed a table. What earns one is the
 * temporal half: `established_at` is when something becomes true in the world,
 * `revealed_at` is when the reader is told, and `fact_knowledge` is who found
 * out before either. Those three are what make a spoiler-safe brief possible in
 * Phase 2, and they are useless unless a writer can see what they add up to.
 *
 * So the centre of this page is not the form. It is the **reading position**: a
 * point in the manuscript, optionally a POV character, and every fact labelled
 * with what it is from there. The rule doing the labelling is the same one the
 * brief compiler will run — `src/domain/factVisibility.ts`, tested exhaustively
 * and stated exactly once.
 */

const STATUS_LABEL: Record<FactStatus, string> = {
  'reader-knows': 'the reader knows',
  'dramatic-irony': 'reader knows, characters do not',
  'pov-knows': 'this character knows, the reader does not',
  withheld: 'true, not yet told',
  'not-yet-established': 'not true yet',
  invalidated: 'no longer true',
  superseded: 'replaced',
};

const STATUS_TONE: Record<FactStatus, string> = {
  'reader-knows': 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-200',
  'dramatic-irony': 'bg-sky-500/15 text-sky-900 dark:text-sky-200',
  'pov-knows': 'bg-sky-500/15 text-sky-900 dark:text-sky-200',
  withheld: 'bg-amber-500/15 text-amber-900 dark:text-amber-200',
  'not-yet-established': 'bg-current/10',
  invalidated: 'bg-current/10 line-through',
  superseded: 'bg-current/10 line-through',
};

export function FactsPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);
  const [knowledge, setKnowledge] = useState<Map<string, KnowledgeRow[]>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  // The reading position lives in the URL, like every other place in the app
  // where "where am I looking from" is a real question.
  const atSceneId = params.get('at') ?? '';
  const povId = params.get('pov') ?? '';
  const setParam = useCallback((key: string, value: string) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [list, ents, books, conf] = await Promise.all([
        db.facts.listFacts(projectId),
        db.codex.listEntities(projectId),
        db.manuscript.listBooks(projectId),
        db.facts.conflicts(projectId),
      ]);
      const order = books[0] ? await db.manuscript.readingOrder(books[0].id) : [];
      const know = await db.facts.knowledgeFor(list.map((f) => f.id));
      if (cancelled) return;
      setFacts(list);
      setEntities(ents);
      setScenes(order);
      setConflicts(conf);
      setKnowledge(know);
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  const atRank = scenes.find((s) => s.id === atSceneId)?.globalRank ?? null;
  const visibility = useMemo<Map<string, FactVisibility>>(
    () => (atRank ? factVisibilityAt(facts, atRank, { povEntityId: povId || null }) : new Map()),
    [facts, atRank, povId]);
  const forbidden = useMemo(
    () => (atRank ? negativeConstraints(facts, visibility) : []), [facts, visibility, atRank]);
  const problems = useMemo(() => continuityProblems(facts), [facts]);

  if (db.state !== 'ready') return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">
        ← Manuscript
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Facts</h1>
      <p className="mt-2 text-xs opacity-60">
        What is true, when it became true, and when the reader finds out. Those
        are different dates, and keeping them apart is what lets the book know
        what it has and has not told anyone yet.
      </p>

      {/* ------------------------------------------------- the reading position */}
      <section className="mt-5 rounded-xl border border-current/15 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-50">
          Seen from
        </h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={atSceneId} onChange={(e) => setParam('at', e.target.value)}
            aria-label="Reading position"
            className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
            <option value="">Anywhere — show everything</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>{s.title ?? 'Untitled scene'}</option>
            ))}
          </select>
          <select
            value={povId} onChange={(e) => setParam('pov', e.target.value)}
            aria-label="Point of view"
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm">
            <option value="">No point of view</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        {atRank ? (
          <p className="mt-2 text-xs opacity-60">
            Each fact below is labelled with what it is at this point. This is the
            same rule that will decide what an AI is allowed to be told.
          </p>
        ) : (
          <p className="mt-2 text-xs opacity-60">
            Choose a scene to see which of these the reader has been told by then.
          </p>
        )}

        {forbidden.length > 0 && (
          <div className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-900
                          dark:text-amber-200">
            <p className="font-medium">
              {forbidden.length} thing{forbidden.length === 1 ? '' : 's'} to keep back here
            </p>
            <p className="mt-1 opacity-80">
              Weighty enough that a model would be told explicitly not to reveal,
              hint at or foreshadow {forbidden.length === 1 ? 'it' : 'them'} —
              silence is not enough, because a model confabulates into a gap.
            </p>
            <ul className="mt-1 list-disc pl-4">
              {forbidden.map((f) => <li key={f.id}>{factOf(facts, f.id)?.statement}</li>)}
            </ul>
          </div>
        )}
      </section>

      {/* --------------------------------------------------------- what is wrong */}
      {(conflicts.length > 0 || problems.length > 0) && (
        <section className="mt-4 rounded-xl border border-amber-500/40 p-4 text-xs">
          <h2 className="font-semibold uppercase tracking-wide opacity-60">Worth a look</h2>
          <ul className="mt-2 space-y-1">
            {conflicts.map((c) => (
              <li key={`${c.factA}:${c.factB}`}>
                Two facts disagree about <strong>{c.predicate}</strong>:{' '}
                &ldquo;{factOf(facts, c.factA)?.statement}&rdquo; and{' '}
                &ldquo;{factOf(facts, c.factB)?.statement}&rdquo;
              </li>
            ))}
            {problems.map((p) => (
              <li key={`${p.factId}:${p.kind}`}>
                {p.detail} — &ldquo;{factOf(facts, p.factId)?.statement}&rdquo;
              </li>
            ))}
          </ul>
        </section>
      )}

      <NewFact
        entities={entities}
        onCreate={async (draft) => {
          const id = await db.facts.createFact(projectId, draft);
          setOpenId(id);
          reload();
        }}
      />

      <ul className="mt-5 divide-y divide-current/10">
        {facts.map((fact) => {
          const seen = visibility.get(fact.id);
          return (
            <li key={fact.id} className="py-3">
              <button
                onClick={() => setOpenId(openId === fact.id ? null : fact.id)}
                aria-expanded={openId === fact.id}
                className="flex w-full flex-wrap items-baseline gap-2 text-left">
                <span className="min-w-0 flex-1 text-sm">{fact.statement}</span>
                {seen && (
                  // The status is an attribute as well as words: the words are
                  // for the writer and change freely, and something has to be
                  // able to name the judgement without matching prose.
                  <span
                    data-status={seen.status}
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[seen.status]}`}>
                    {STATUS_LABEL[seen.status]}
                  </span>
                )}
                {fact.spoilerWeight > 0 && (
                  <span className="shrink-0 text-xs opacity-40">
                    spoiler {fact.spoilerWeight}
                  </span>
                )}
              </button>
              {openId === fact.id && (
                <FactEditor
                  fact={fact}
                  scenes={scenes}
                  entities={entities}
                  knows={knowledge.get(fact.id) ?? []}
                  onChanged={reload}
                />
              )}
            </li>
          );
        })}
        {facts.length === 0 && (
          <li className="py-3 text-sm opacity-60">
            Nothing recorded yet. A fact is anything the book has to keep
            straight — who is related to whom, what is buried where, who is
            lying.
          </li>
        )}
      </ul>
    </div>
  );
}

const factOf = (facts: Fact[], id: string) => facts.find((f) => f.id === id);

function NewFact(
  { entities, onCreate }:
  { entities: Entity[]; onCreate: (d: { subjectEntityId: string | null; predicate: string;
    objectText: string | null }) => Promise<void> },
) {
  const [subject, setSubject] = useState('');
  const [predicate, setPredicate] = useState('');
  const [object, setObject] = useState('');

  return (
    <form
      className="mt-5 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!predicate.trim()) return;
        const draft = {
          subjectEntityId: subject || null,
          predicate: predicate.trim(),
          objectText: object.trim() || null,
        };
        setPredicate('');
        setObject('');
        await onCreate(draft);
      }}>
      <select
        value={subject} onChange={(e) => setSubject(e.target.value)}
        aria-label="Subject"
        className="rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm">
        <option value="">(no subject)</option>
        {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      {/* Subject, predicate and object are what make contradiction detection a
          query rather than a judgement — two facts about the same subject and
          predicate with different objects cannot both be true. */}
      <input
        value={predicate} onChange={(e) => setPredicate(e.target.value)}
        placeholder="is, carries, eye colour…" aria-label="Predicate"
        className="rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm"
      />
      <input
        value={object} onChange={(e) => setObject(e.target.value)}
        placeholder="the heir, grey…" aria-label="Object"
        className="rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm"
      />
      <button type="submit"
        className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
        Record
      </button>
    </form>
  );
}

function FactEditor({ fact, scenes, entities, knows, onChanged }: {
  fact: Fact;
  scenes: SceneSummary[];
  entities: Entity[];
  knows: KnowledgeRow[];
  onChanged: () => void;
}) {
  const db = useDb();
  const [adding, setAdding] = useState('');
  if (db.state !== 'ready') return null;

  const patch = async (p: Parameters<typeof db.facts.updateFact>[1]) => {
    await db.facts.updateFact(fact.id, p);
    onChanged();
  };

  const scenePicker = (
    label: string, hint: string, value: string | null,
    onPick: (id: string | null) => void,
  ) => (
    <label className="block text-xs">
      <span className="opacity-60">{label}</span>
      <span className="block opacity-40">{hint}</span>
      <select
        value={value ?? ''} aria-label={label}
        onChange={(e) => onPick(e.currentTarget.value || null)}
        className="mt-1 w-full rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm">
        <option value="">—</option>
        {scenes.map((s) => <option key={s.id} value={s.id}>{s.title ?? 'Untitled scene'}</option>)}
      </select>
    </label>
  );

  return (
    <div className="mt-3 rounded-xl border border-current/15 p-4">
      <label className="block text-xs">
        <span className="opacity-60">As the book will state it</span>
        <input
          defaultValue={fact.statement} aria-label="Statement"
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== fact.statement) void patch({ statement: v });
          }}
          className="mt-1 w-full rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm"
        />
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {scenePicker('Becomes true', 'blank means it always was',
          fact.establishedSceneId, (id) => void patch({ establishedSceneId: id }))}
        {scenePicker('Reader is told', 'blank means never on the page',
          fact.revealedSceneId, (id) => void patch({ revealedSceneId: id }))}
        {scenePicker('Stops being true', 'blank means it still is',
          fact.invalidatedSceneId, (id) => void patch({ invalidatedSceneId: id }))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2">
          <span className="opacity-60">How badly early exposure hurts</span>
          <select
            defaultValue={String(fact.spoilerWeight)} aria-label="Spoiler weight"
            onChange={(e) => void patch({ spoilerWeight: Number(e.currentTarget.value) })}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1">
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="opacity-60">Certainty</span>
          <select
            defaultValue={fact.certainty} aria-label="Certainty"
            onChange={(e) => void patch({
              certainty: e.currentTarget.value as typeof fact.certainty,
            })}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1">
            {['canon', 'planned', 'speculative'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 opacity-70">
          <input
            type="checkbox" defaultChecked={fact.isDramaticIrony}
            aria-label="Dramatic irony"
            onChange={(e) => void patch({ isDramaticIrony: e.currentTarget.checked })}
          />
          The reader knows, the characters do not
        </label>
      </div>

      {/* ---------------------------------------------------------- who knows */}
      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide opacity-50">
        Who knows
      </h3>
      <p className="mt-1 text-xs opacity-60">
        A character who knows this can act on it before the reader is told. Being
        lied to is recorded here too, and does not count as knowing.
      </p>
      <ul className="mt-2 space-y-1">
        {knows.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{k.entityName}</span>
            <select
              defaultValue={k.belief} aria-label={`What ${k.entityName} believes`}
              onChange={(e) => void db.facts
                .setKnowledge(fact.id, k.entityId, {
                  belief: e.currentTarget.value as Belief,
                  knownFromSceneId: k.knownFromSceneId,
                })
                .then(onChanged)}
              className="rounded-lg border border-current/20 bg-transparent px-2 py-0.5 text-xs">
              {['knows', 'suspects', 'believes_false', 'denies'].map((b) => (
                <option key={b} value={b}>{b.replace('_', ' ')}</option>
              ))}
            </select>
            <select
              defaultValue={k.knownFromSceneId ?? ''} aria-label={`When ${k.entityName} found out`}
              onChange={(e) => void db.facts
                .setKnowledge(fact.id, k.entityId, {
                  belief: k.belief,
                  knownFromSceneId: e.currentTarget.value || null,
                })
                .then(onChanged)}
              className="rounded-lg border border-current/20 bg-transparent px-2 py-0.5 text-xs">
              <option value="">from the start</option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>{s.title ?? 'Untitled scene'}</option>
              ))}
            </select>
            <button
              onClick={() => void db.facts.removeKnowledge(fact.id, k.entityId).then(onChanged)}
              className="text-xs underline opacity-50">
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <select
          value={adding} onChange={(e) => setAdding(e.target.value)}
          aria-label="Someone who knows"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm">
          <option value="">Add someone…</option>
          {entities.filter((e) => !knows.some((k) => k.entityId === e.id))
            .map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button
          disabled={!adding}
          onClick={() => {
            const id = adding;
            setAdding('');
            void db.facts.setKnowledge(fact.id, id).then(onChanged);
          }}
          className="rounded-lg border border-current/20 px-3 py-1 text-sm disabled:opacity-40">
          They know
        </button>
      </div>

      <button
        onClick={() => void db.facts.removeFact(fact.id).then(onChanged)}
        className="mt-5 text-xs underline opacity-50">
        Delete this fact
      </button>
    </div>
  );
}
