import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import { rebuildKind } from '../index/rebuild';
import type {
  Entity, EntityType, EntityDetail, AttributeField,
} from '../data/codexRepository';

/**
 * The codex — the other half of the lore-linking claim.
 *
 * Mention detection has been built and tested for several commits and had
 * nothing to match, because there was no way to create an entity. This is that
 * way.
 *
 * Two things are load-bearing rather than cosmetic:
 *
 * **The attribute fields come from the type's JSON Schema.** Migration 002 says
 * a field added there "appears in the UI without code", and this is what makes
 * that true rather than a comment describing an intention.
 *
 * **An alias edit re-scans the manuscript.** Adding "the Warden" changes what
 * every existing scene means, retroactively; the repository marks the index
 * stale and this runs the rebuild, visibly, rather than leaving a red flag in
 * settings for the writer to find later.
 */

export function CodexPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [types, setTypes] = useState<EntityType[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [t, e] = await Promise.all([
        db.codex.listTypes(projectId),
        db.codex.listEntities(projectId, { typeKey: typeFilter || undefined, search }),
      ]);
      if (!cancelled) { setTypes(t); setEntities(e); }
    })();
    return () => { cancelled = true; };
  }, [db, projectId, typeFilter, search, generation]);

  useEffect(() => {
    if (db.state !== 'ready' || !openId) return;
    let cancelled = false;
    void (async () => {
      const d = await db.codex.getEntity(openId);
      if (!cancelled) setDetail(d);
    })();
    return () => { cancelled = true; };
  }, [db, openId, generation]);

  /**
   * Re-scan after anything that changes what the aliases mean.
   *
   * Not left to the settings panel: a writer who adds an alias expects their
   * manuscript to start recognising it, and being sent to a different screen to
   * press a button is the "support incident" doc 02 §9b says to avoid.
   */
  const rescan = useCallback(async () => {
    if (db.state !== 'ready') return;
    setRescanning(true);
    try { await rebuildKind(db.driver, projectId, 'mention'); }
    finally { setRescanning(false); }
  }, [db, projectId]);

  if (db.state !== 'ready') return null;
  const open = detail && detail.entity.id === openId ? detail : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">
        ← Manuscript
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Codex</h1>
      <p className="mt-2 text-xs opacity-60">
        Everything your book knows about. Anything here with an alias is found in
        your prose automatically&nbsp;— add one for every name a character is
        called by.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search names and aliases" aria-label="Search the codex"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm"
        />
        <select
          value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by type"
          className="rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm">
          <option value="">All types</option>
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>

      <NewEntity
        types={types}
        disabled={rescanning}
        onCreate={async (name, typeKey) => {
          const created = await db.codex.createEntity(projectId, { name, typeKey });
          setOpenId(created.id);
          reload();
          await rescan();
        }}
      />

      <ul className="mt-5 divide-y divide-current/10">
        {entities.map((e) => (
          <li key={e.id}>
            <button
              onClick={() => setOpenId(openId === e.id ? null : e.id)}
              aria-expanded={openId === e.id}
              className="flex w-full items-center gap-3 py-2.5 text-left text-sm hover:bg-current/5">
              <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
              <span className="shrink-0 text-xs opacity-50">
                {types.find((t) => t.key === e.typeKey)?.label ?? e.typeKey}
              </span>
              <span className="shrink-0 text-xs opacity-40">{e.importance}</span>
            </button>
            {openId === e.id && open && (
              <EntityEditor
                detail={open}
                type={types.find((t) => t.key === open.entity.typeKey) ?? null}
                types={types}
                projectId={projectId}
                others={entities.filter((o) => o.id !== e.id)}
                busy={rescanning}
                onChanged={reload}
                onAliasesChanged={async () => { reload(); await rescan(); }}
              />
            )}
          </li>
        ))}
        {entities.length === 0 && (
          <li className="py-3 text-sm opacity-60">
            {search || typeFilter ? 'Nothing matches.' : 'Nothing here yet.'}
          </li>
        )}
      </ul>

      {rescanning && (
        <p aria-live="polite" className="mt-4 text-xs opacity-60">
          Re-reading the manuscript for the new names…
        </p>
      )}
    </div>
  );
}

function NewEntity(
  { types, disabled, onCreate }:
  { types: EntityType[]; disabled: boolean; onCreate: (n: string, t: string) => Promise<void> },
) {
  const [name, setName] = useState('');
  const [typeKey, setTypeKey] = useState('character');
  return (
    <form
      className="mt-3 flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const n = name.trim();
        setName('');
        await onCreate(n, typeKey);
      }}>
      <input
        value={name} onChange={(e) => setName(e.target.value)}
        placeholder="A character, place or thing" aria-label="New entity name"
        className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm"
      />
      <select
        value={typeKey} onChange={(e) => setTypeKey(e.target.value)}
        aria-label="New entity type"
        className="rounded-lg border border-current/20 bg-transparent px-2 py-2 text-sm">
        {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      <button type="submit" disabled={disabled}
        className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                   font-medium disabled:opacity-50">
        Add
      </button>
    </form>
  );
}

function EntityEditor({ detail, type, types, projectId, others, busy, onChanged, onAliasesChanged }: {
  detail: EntityDetail;
  type: EntityType | null;
  types: EntityType[];
  projectId: string;
  others: Entity[];
  busy: boolean;
  onChanged: () => void;
  onAliasesChanged: () => Promise<void>;
}) {
  const db = useDb();
  const { entity, aliases, relationships } = detail;
  const [newAlias, setNewAlias] = useState('');
  const fields = useMemo<AttributeField[]>(() => type?.attributes ?? [], [type]);
  if (db.state !== 'ready') return null;

  const patch = async (p: Parameters<typeof db.codex.updateEntity>[1]) => {
    await db.codex.updateEntity(entity.id, p);
    onChanged();
  };

  return (
    <div className="mb-4 rounded-xl border border-current/15 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            defaultValue={entity.name} aria-label="Name"
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              // A rename carries the primary alias, so this re-scans too.
              if (v && v !== entity.name) void db.codex.updateEntity(entity.id, { name: v })
                .then(() => onAliasesChanged());
            }}
            className={INPUT} />
        </Field>
        <Field label="Type">
          <select defaultValue={entity.typeKey} aria-label="Type"
            onChange={(e) => void patch({ typeKey: e.currentTarget.value })} className={INPUT}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Importance">
          <select defaultValue={entity.importance} aria-label="Importance"
            onChange={(e) => void patch({ importance: e.currentTarget.value })} className={INPUT}>
            {['protagonist', 'major', 'minor', 'background'].map((v) =>
              <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <input defaultValue={entity.status ?? ''} aria-label="Status"
            placeholder="alive, destroyed, unknown…"
            onBlur={(e) => void patch({ status: e.currentTarget.value.trim() || null })}
            className={INPUT} />
        </Field>
      </div>

      <Field label="One line, for compact briefs">
        <input defaultValue={entity.summary ?? ''} aria-label="Summary"
          onBlur={(e) => void patch({ summary: e.currentTarget.value.trim() || null })}
          className={INPUT} />
      </Field>
      <Field label="Description">
        <textarea defaultValue={entity.description ?? ''} aria-label="Description" rows={3}
          onBlur={(e) => void patch({ description: e.currentTarget.value.trim() || null })}
          className={INPUT} />
      </Field>

      {/* Straight from the type's JSON Schema. Adding a property to
          db/migrations/002 puts a field here without touching this file. */}
      {fields.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.name} className={f.long ? 'sm:col-span-2' : ''}>
              <Field label={f.label}>
                {f.long ? (
                  <textarea
                    defaultValue={entity.attributes[f.name] ?? ''} aria-label={f.label} rows={2}
                    onBlur={(e) => void patch({
                      attributes: { ...entity.attributes, [f.name]: e.currentTarget.value },
                    })}
                    className={INPUT} />
                ) : (
                  <input
                    defaultValue={entity.attributes[f.name] ?? ''} aria-label={f.label}
                    onBlur={(e) => void patch({
                      attributes: { ...entity.attributes, [f.name]: e.currentTarget.value },
                    })}
                    className={INPUT} />
                )}
              </Field>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------------ aliases */}
      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide opacity-50">
        Names this is called by
      </h3>
      <p className="mt-1 text-xs opacity-60">
        Each one is matched in your prose. Switch one off if it is too common a
        word to link safely.
      </p>
      <ul className="mt-2 space-y-1">
        {aliases.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{a.alias}</span>
            {a.isPrimary && <span className="shrink-0 text-xs opacity-40">primary</span>}
            <label className="flex shrink-0 items-center gap-1 text-xs opacity-60">
              <input
                type="checkbox" defaultChecked={a.autoLink}
                aria-label={`Link ${a.alias} in prose`}
                onChange={(e) => void db.codex.updateAlias(a.id, { autoLink: e.currentTarget.checked })
                  .then(() => onAliasesChanged())}
              />
              link
            </label>
            {!a.isPrimary && (
              <button disabled={busy}
                onClick={() => void db.codex.removeAlias(a.id).then(() => onAliasesChanged())}
                className="shrink-0 text-xs underline opacity-50 disabled:opacity-30">
                remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = newAlias.trim();
          if (!v) return;
          setNewAlias('');
          void db.codex.addAlias(entity.id, v).then(() => onAliasesChanged());
        }}>
        <input
          value={newAlias} onChange={(e) => setNewAlias(e.target.value)}
          placeholder="Another name, title or epithet" aria-label="New alias"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm"
        />
        <button type="submit" disabled={busy}
          className="rounded-lg border border-current/20 px-3 py-1 text-sm disabled:opacity-50">
          Add name
        </button>
      </form>

      {/* ------------------------------------------------------ relationships */}
      {others.length > 0 && (
        <>
          <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide opacity-50">
            Connections
          </h3>
          <ul className="mt-2 space-y-1">
            {relationships.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {r.outgoing ? '→' : '←'} {r.kind} {r.otherName}
                </span>
                <button
                  onClick={() => void db.codex.removeRelationship(r.id).then(onChanged)}
                  className="shrink-0 text-xs underline opacity-50">
                  remove
                </button>
              </li>
            ))}
          </ul>
          <NewRelationship
            others={others}
            onAdd={async (toId, kind) => {
              await db.codex.addRelationship(projectId, entity.id, toId, kind);
              onChanged();
            }}
          />
        </>
      )}

      {/* ----------------------------------------------------- the hard floor */}
      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide opacity-50">
        Before any AI sees this
      </h3>
      <p className="mt-1 text-xs opacity-60">
        These are checked before a model is asked anything about this entity.
        Left unset they stay <em>unknown</em>, which is the honest answer and the
        safer one.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-xs opacity-60">Adult or minor</span>
          <select defaultValue={entity.maturity} aria-label="Maturity"
            onChange={(e) => void patch({ maturity: e.currentTarget.value })}
            className="rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm">
            {['unknown', 'adult', 'minor', 'n_a'].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs opacity-70">
          <input
            type="checkbox" defaultChecked={entity.isRealPerson} aria-label="Is a real person"
            onChange={(e) => void patch({ isRealPerson: e.currentTarget.checked })} />
          Based on a real person
        </label>
      </div>

      <button
        disabled={busy}
        onClick={() => void db.codex.removeEntity(entity.id).then(() => onAliasesChanged())}
        className="mt-5 text-xs underline opacity-50 disabled:opacity-30">
        Delete this entry
      </button>
    </div>
  );
}

function NewRelationship(
  { others, onAdd }: { others: Entity[]; onAdd: (toId: string, kind: string) => Promise<void> },
) {
  const [toId, setToId] = useState(others[0]?.id ?? '');
  const [kind, setKind] = useState('knows');
  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!toId || !kind.trim()) return;
        await onAdd(toId, kind.trim());
      }}>
      <input
        value={kind} onChange={(e) => setKind(e.target.value)}
        aria-label="Connection kind" placeholder="serves, loves, located in…"
        className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm"
      />
      <select value={toId} onChange={(e) => setToId(e.target.value)}
        aria-label="Connect to"
        className="rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm">
        {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <button type="submit"
        className="rounded-lg border border-current/20 px-3 py-1 text-sm">
        Connect
      </button>
    </form>
  );
}

const INPUT = 'mt-1 w-full rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block text-xs">
      <span className="opacity-60">{label}</span>
      {children}
    </label>
  );
}
