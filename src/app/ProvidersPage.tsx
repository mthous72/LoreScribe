import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDb } from './DbProvider';
import { OpenRouterAdapter } from '../ai/openrouter';
import type { DataPolicy, ModelInfo } from '../ai/provider';
import { explainProviderError as explain } from '../ai/explain';
import type { ModelProfile, ProfileRole, ProviderAccount } from '../data/providerRepository';

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
 */

const ROLES: { role: ProfileRole; what: string }[] = [
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
  const { projectId = '' } = useParams();
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

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const [a, p] = await Promise.all([db.providers.listAccounts(), db.providers.listProfiles(projectId)]);
      if (cancelled) return;
      setAccounts(a);
      setProfiles(p);
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
    await providers.setProfile(projectId, role, {
      providerAccountId: account.id, modelId,
      contextWindow: model?.contextWindow ?? null,
      costInPerMtok: model?.costInPerMtok ?? null,
      costOutPerMtok: model?.costOutPerMtok ?? null,
    });
    return `${role}: ${model?.name ?? modelId}.`;
  });

  const tested = accounts.filter((a) => models[a.id]?.length);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">← Manuscript</Link>
      <h1 className="mt-4 text-xl font-semibold">Providers</h1>
      <p className="mt-2 text-sm opacity-70">
        Your own OpenRouter key, called directly from this browser. Nothing goes
        through a server of ours, because there is not one.
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

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wide opacity-50">Which model does which job</h2>
      {tested.length === 0 ? (
        <p className="mt-2 text-sm opacity-60">
          Test a key first, and its models will be offered here. Drafting deserves a strong
          model; the other jobs fire far more often and are fine on a cheap one.
        </p>
      ) : (
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
                      <option value="">{current ? `${current.modelId} (kept)` : 'choose a model…'}</option>
                      {tested.flatMap((a) => (models[a.id] ?? []).map((m) => (
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
      )}
    </div>
  );
}
