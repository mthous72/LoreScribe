import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import { OpenRouterAdapter } from '../ai/openrouter';
import type { DataPolicy, ModelInfo } from '../ai/provider';
import { explainProviderError as explain } from '../ai/explain';
import type { ModelProfile, ProfileRole, ProviderAccount } from '../data/providerRepository';
import type { Project } from '../data/projectRepository';
import { usd, type SpendMeter } from '../domain/spend';
import { filterModels, sortByPrice, type ModelFilters } from '../ai/modelFilter';

/**
 * Accounts, keys, and which model does which job.
 *
 * Three things a writer needs to be told here, in words rather than icons:
 *
 * **Where the key is, and what that protects** ([D30](../../docs/10-decisions.md)).
 * The key is sealed with a device key the browser keeps and never hands back,
 * and the database holds only a handle. That keeps it out of exports, backups
 * and storage dumps; it does not keep it from code running as this app on this
 * device. Saying the second half is the difference between a padlock and an
 * honest statement.
 *
 * **Whether the key works.** "Test this key" is the live spike doc 08 names —
 * the browser making the call directly, CORS and all — and its answer is one
 * sentence per thing that can go wrong, not the upstream's error text.
 *
 * **Which model does which job** ([doc 06](../../docs/06-ai-pipeline.md)). The
 * app calls a role, not a model. Drafting on a strong model and summarising on
 * a cheap one is roughly an order of magnitude in running cost, because the
 * cheap roles fire far more often, so the roles are laid out as a table rather
 * than buried in a settings list. The model's window and prices are copied
 * onto the profile when it is chosen: the budget needs the window before a
 * call, and the number a run was costed against is the number kept.
 *
 * **What today has cost, and where it stops** ([D17](../../docs/10-decisions.md)).
 * Two numbers per project, a warning and a stop, both per local day, both
 * editable here in full. The panel that hits the stop offers the doubling;
 * this is where a writer sets them on purpose.
 *
 * **One overall choice, then exceptions.** The `default` row is the model
 * every job uses when it has none of its own, kept with no project so it
 * holds for all of them; a job set below it, for this project, overrides it.
 * The list under each is cheapest first, with the two filters a writer
 * reaches for in a list of hundreds: free, and unmoderated.
 *
 * Reached two ways. The **Settings** tab in the top bar opens it with no
 * project fixed — the key is not a project's, and the first thing a new
 * writer needs is a place to put it before any book exists — and the roles
 * and the spend then belong to whichever project is picked at the top, the
 * most recent by default. A project's own link fixes the project.
 */

const ROLES: { role: ProfileRole; what: string }[] = [
  { role: 'default', what: 'every job not set below — one choice, kept for all your projects' },
  { role: 'draft', what: 'writes prose — the one place quality is the whole point' },
  { role: 'revise', what: 'patches flagged spans, never the whole scene' },
  { role: 'critique', what: 'checks a draft against the laws and the beats' },
  { role: 'summarise', what: 'writes the scene and chapter summaries the ladder reads' },
  { role: 'extract', what: 'proposes codex entries and facts from prose' },
  { role: 'name', what: 'names things' },
];

const POLICIES: { value: DataPolicy; text: string }[] = [
  { value: 'no_training', text: 'Route only to providers that do not train on inputs' },
  { value: 'zero_retention', text: 'Route only to providers that retain nothing' },
  { value: 'any', text: 'Any provider — an explicit opt-in' },
];

const money = (perMtok: number | null) =>
  perMtok === null ? '' : `$${perMtok < 1 ? perMtok.toFixed(2) : perMtok.toFixed(0)}/M`;

export function ProvidersPage() {
  const db = useDb();
  const { projectId: routeProject } = useParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [picked, setPicked] = useState<string>('');
  const projectId = routeProject ?? picked;
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [meter, setMeter] = useState<SpendMeter | null>(null);
  /** The inputs, and which project they were loaded for: a refresh must not overwrite what is being typed. */
  const [caps, setCaps] = useState<{ forProject: string; warn: string; stop: string } | null>(null);
  const [filters, setFilters] = useState<ModelFilters>({ free: false, uncensored: false });

  // The key is not a project's: accounts load whether or not one is fixed.
  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const [a, list] = await Promise.all([
        db.providers.listAccounts(), routeProject ? [] : db.projects.list(),
      ]);
      if (cancelled) return;
      setAccounts(a);
      if (!routeProject) {
        setProjects(list);
        // The most recent project, until the writer picks another.
        setPicked((p) => (p && list.some((x) => x.id === p) ? p : list[0]?.id ?? ''));
      }
    })();
    return () => { cancelled = true; };
  }, [db, routeProject, generation]);

  // The roles and the spend are a project's.
  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [p, m] = await Promise.all([db.providers.listProfiles(projectId), db.spend.meter(projectId)]);
      if (cancelled) return;
      setProfiles(p);
      setMeter(m);
      // The inputs follow the saved caps for a newly picked project, and are
      // otherwise left alone: a refetch after a save or a test must not undo
      // what the writer is typing.
      setCaps((c) => (c && c.forProject === projectId
        ? c
        : { forProject: projectId, warn: String(m.caps.warnUsd), stop: String(m.caps.stopUsd) }));
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  const act = useCallback(async (job: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const said = await job();
      setNote(said ?? null);
    } catch (e) {
      setNote(explain(e));
    } finally {
      setBusy(false);
      reload();
    }
  }, [reload]);

  if (db.state !== 'ready') return null;
  const { providers, credentials } = db;

  const add = () => void act(async () => {
    const account = await providers.addAccount({ kind: 'openrouter', label: label.trim() || 'OpenRouter' });
    if (key.trim()) {
      await credentials.save(account.id, key.trim());
      await providers.setCredentialRef(account.id, account.id);
    }
    setLabel('');
    setKey('');
    return key.trim()
      ? 'Account added and the key saved on this device.'
      : 'Account added. Save a key before testing it.';
  });

  const saveKey = (account: ProviderAccount) => void act(async () => {
    const value = (newKey[account.id] ?? '').trim();
    if (!value) return 'Nothing to save.';
    await credentials.save(account.id, value);
    await providers.setCredentialRef(account.id, account.id);
    setNewKey((k) => ({ ...k, [account.id]: '' }));
    return 'Key saved on this device.';
  });

  const adapterFor = async (account: ProviderAccount) => {
    const secret = account.credentialRef ? await credentials.load(account.credentialRef) : null;
    if (!secret) throw new Error('No key is saved for this account on this device.');
    return new OpenRouterAdapter({
      apiKey: secret, baseUrl: account.baseUrl ?? undefined,
      referer: window.location.origin, title: 'LoreScribe',
    });
  };

  const test = (account: ProviderAccount) => void act(async () => {
    const adapter = await adapterFor(account);
    // The key first, on the endpoint that needs one. The model list is public
    // and would say "works" to anything.
    const info = await adapter.verify();
    const list = await adapter.listModels();
    list.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    setModels((m) => ({ ...m, [account.id]: list }));
    const spend = info.usage === null ? ''
      : info.limit === null
        ? ` It has spent $${info.usage.toFixed(2)} so far, with no limit set.`
        : ` It has spent $${info.usage.toFixed(2)} of a $${info.limit.toFixed(2)} limit.`;
    return `The key works.${spend} OpenRouter offers ${list.length.toLocaleString()} models to it.`;
  });

  const remove = (account: ProviderAccount) => void act(async () => {
    if (account.credentialRef) await credentials.forget(account.credentialRef);
    await providers.removeAccount(account.id);
    return 'Account removed and its key forgotten.';
  });

  const choose = (role: ProfileRole, account: ProviderAccount, modelId: string) => void act(async () => {
    if (!modelId) return;
    const model = models[account.id]?.find((m) => m.id === modelId);
    // The default is the overall choice: no project, so every project reads it.
    await providers.setProfile(role === 'default' ? null : projectId, role, {
      providerAccountId: account.id, modelId,
      contextWindow: model?.contextWindow ?? null,
      costInPerMtok: model?.costInPerMtok ?? null,
      costOutPerMtok: model?.costOutPerMtok ?? null,
    });
    return `${role}: ${model?.name ?? modelId}.`;
  });

  const saveCaps = () => void act(async () => {
    if (!caps) return;
    const saved = await db.spend.setCaps(projectId, {
      warnUsd: Number(caps.warn), stopUsd: Number(caps.stop),
    });
    setCaps({ forProject: projectId, warn: String(saved.warnUsd), stop: String(saved.stopUsd) });
    return `This project now warns at ${usd(saved.warnUsd)} and stops at ${usd(saved.stopUsd)} a day.`;
  });

  const tested = accounts.filter((a) => models[a.id]?.length);
  const offered = Object.fromEntries(
    tested.map((a) => [a.id, sortByPrice(filterModels(models[a.id] ?? [], filters))]));
  const fallback = profiles.find((p) => p.role === 'default');
  const totalModels = tested.reduce((n, a) => n + (models[a.id]?.length ?? 0), 0);
  const shownModels = tested.reduce((n, a) => n + (offered[a.id]?.length ?? 0), 0);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {routeProject && (
        <Link to={`/project/${routeProject}`} className="text-xs underline opacity-60">← Manuscript</Link>
      )}
      <h1 className={`${routeProject ? 'mt-4 ' : ''}text-xl font-semibold`}>Settings</h1>
      <p className="mt-2 text-sm opacity-70">
        Your own OpenRouter key, called directly from this browser. Nothing goes
        through a server of ours, because there is not one. Then which model does
        which job, and how much a day may cost, for each project.
      </p>

      <section className="mt-6 rounded-lg border border-current/15 p-3 text-xs leading-relaxed opacity-80"
        data-testid="key-protection">
        <p>
          <strong>Where the key is kept.</strong> It is encrypted with a key this browser
          generates and will not hand back, and stored in this browser&rsquo;s own
          storage. The database holds only a reference to it, so the key is never in a
          backup, an export, or anything you hand to somebody else.
        </p>
        <p className="mt-1.5">
          <strong>What that does not protect against:</strong> anything running as this
          app on this device can use the key, exactly as the app does. The device&rsquo;s
          own lock is the boundary — the same one that protects the manuscript.
        </p>
      </section>

      {note && <p aria-live="polite" role="status" className="mt-4 text-sm opacity-80">{note}</p>}

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wide opacity-50">Accounts</h2>
      {accounts.length === 0 && (
        <p className="mt-2 text-sm opacity-60">No accounts yet. Add your OpenRouter key below.</p>
      )}
      <ul className="mt-2 space-y-4">
        {accounts.map((account) => (
          <li key={account.id} data-account={account.id} className="rounded-lg border border-current/15 p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{account.label}</span>
              <span className="text-xs opacity-50">{account.kind}</span>
              <span className="text-xs opacity-70" data-testid="key-state">
                {account.credentialRef ? 'key saved on this device' : 'no key saved'}
              </span>
              <span className="flex-1" />
              <button
                disabled={busy || !account.credentialRef}
                onClick={() => test(account)}
                className="text-xs underline opacity-70 disabled:opacity-30">
                Test this key
              </button>
              <button
                disabled={busy}
                onClick={() => remove(account)}
                className="text-xs underline opacity-50 disabled:opacity-30">
                remove
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`key-${account.id}`}>
                {account.credentialRef ? `Replace the key for ${account.label}` : `Key for ${account.label}`}
              </label>
              <input
                id={`key-${account.id}`}
                type="password"
                autoComplete="off"
                value={newKey[account.id] ?? ''}
                onChange={(e) => setNewKey((k) => ({ ...k, [account.id]: e.target.value }))}
                placeholder={account.credentialRef ? 'paste a new key to replace it' : 'sk-or-v1-…'}
                className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm"
              />
              <button
                disabled={busy || !(newKey[account.id] ?? '').trim()}
                onClick={() => saveKey(account)}
                className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                           font-medium disabled:opacity-50">
                Save key
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <label htmlFor={`policy-${account.id}`} className="opacity-60">Data policy</label>
              <select
                id={`policy-${account.id}`}
                value={account.dataPolicy}
                disabled={busy}
                onChange={(e) => void act(() =>
                  providers.setDataPolicy(account.id, e.target.value as DataPolicy))}
                className="rounded border border-current/20 bg-transparent px-1 py-0.5">
                {POLICIES.map((p) => <option key={p.value} value={p.value}>{p.text}</option>)}
              </select>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="account-label">Account label</label>
        <input
          id="account-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="OpenRouter"
          className="w-40 rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm"
        />
        <label className="sr-only" htmlFor="account-key">OpenRouter API key</label>
        <input
          id="account-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-or-v1-…"
          className="min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-2.5 py-1.5 text-sm"
        />
        <button
          disabled={busy}
          onClick={add}
          className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                     font-medium disabled:opacity-50">
          Add an OpenRouter account
        </button>
      </div>

      {!routeProject && (
        <div className="mt-10 flex flex-wrap items-center gap-2 text-sm" data-testid="project-picker">
          <label htmlFor="settings-project" className="opacity-70">For the project</label>
          {projects.length === 0
            ? <span className="opacity-60">— none yet. Create one on the Projects page; the key above is already kept.</span>
            : (
              <select
                id="settings-project" value={picked} onChange={(e) => setPicked(e.target.value)}
                className="rounded-lg border border-current/20 bg-transparent px-2 py-1">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            )}
        </div>
      )}

      {projectId && (<>
        <h2 className="mt-10 text-xs font-semibold uppercase tracking-wide opacity-50">Which model does which job</h2>
        {tested.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">
            Test a key first, and its models will be offered here. Drafting deserves a strong
            model; the other jobs fire far more often and are fine on a cheap one.
          </p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="model-filters">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={filters.free}
                  onChange={(e) => setFilters((f) => ({ ...f, free: e.target.checked }))} />
                Free only
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={filters.uncensored}
                  onChange={(e) => setFilters((f) => ({ ...f, uncensored: e.target.checked }))} />
                Uncensored only
                <span className="opacity-50">— no provider-side moderation; the model may still decline</span>
              </label>
              <span className="opacity-50 tabular-nums" data-testid="model-count">
                {shownModels === totalModels ? `${totalModels} models` : `${shownModels} of ${totalModels} models`}
              </span>
            </div>
            <table className="mt-2 w-full text-sm" data-testid="roles">
              <tbody>
                {ROLES.map(({ role, what }) => {
                  const current = profiles.find((p) => p.role === role);
                  return (
                    <tr key={role} data-role={role} className="align-baseline">
                      <th scope="row" className="py-1.5 pr-3 text-left font-medium">{role}</th>
                      <td className="py-1.5 pr-3 text-xs opacity-60">{what}</td>
                      <td className="py-1.5">
                        <select
                          aria-label={`Model for ${role}`}
                          value={current?.modelId ?? ''}
                          disabled={busy}
                          onChange={(e) => {
                            const [accountId, ...rest] = e.target.value.split('|');
                            const account = accounts.find((a) => a.id === accountId);
                            if (account) choose(role, account, rest.join('|'));
                          }}
                          className="max-w-[20rem] rounded border border-current/20 bg-transparent px-1 py-0.5
                                 text-xs">
                          <option value="">
                            {current ? `${current.modelId} (kept)`
                              : fallback && role !== 'default' ? `uses the default: ${fallback.modelId}`
                                : 'choose a model…'}
                          </option>
                          {tested.flatMap((a) => (offered[a.id] ?? []).map((m) => (
                            <option key={`${a.id}|${m.id}`} value={`${a.id}|${m.id}`}>
                              {m.name} · {(m.contextWindow / 1000).toFixed(0)}k
                              {m.costInPerMtok !== null ? ` · ${money(m.costInPerMtok)} in, ${money(m.costOutPerMtok)} out` : ''}
                              {m.moderated ? ' · moderated' : ''}
                            </option>
                          )))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        <h2 id="spend" className="mt-10 text-xs font-semibold uppercase tracking-wide opacity-50">Spend</h2>
        {meter && (
          <p className="mt-2 text-sm" data-testid="spend-today" data-level={meter.level}>
            <strong>{usd(meter.todayUsd)}</strong> spent on this project today
            {meter.unpricedRuns > 0 && (
              <>, not counting {meter.unpricedRuns} {meter.unpricedRuns === 1 ? 'run' : 'runs'} whose model had no price</>
            )}
            .
            {meter.level === 'stop' && ' Drafting is stopped until the stop is raised or the day turns.'}
            {meter.level === 'warn' && ' That is past the warning.'}
          </p>
        )}
        <p className="mt-1 text-xs opacity-60">
          Per local day, per project. A guard against a loop or a runaway batch, not a budget: raise
          it the first time it gets in the way of real work.
        </p>
        {caps && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="cap-warn" className="opacity-70">Warn at $</label>
            <input
              id="cap-warn"
              inputMode="decimal"
              value={caps.warn}
              onChange={(e) => setCaps({ ...caps, warn: e.target.value })}
              className="w-20 rounded-lg border border-current/20 bg-transparent px-2 py-1"
            />
            <label htmlFor="cap-stop" className="opacity-70">Stop at $</label>
            <input
              id="cap-stop"
              inputMode="decimal"
              value={caps.stop}
              onChange={(e) => setCaps({ ...caps, stop: e.target.value })}
              className="w-20 rounded-lg border border-current/20 bg-transparent px-2 py-1"
            />
            <button
              disabled={busy}
              onClick={saveCaps}
              className="rounded-lg border border-current/20 bg-current/10 px-3 py-1.5 text-sm
                       font-medium disabled:opacity-50">
              Save the caps
            </button>
          </div>
        )}
      </>)}
    </div>
  );
}
