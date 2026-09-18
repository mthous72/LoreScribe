import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { ProviderRepository } from './providerRepository';

let driver: NodeSqlDriver;
let repo: ProviderRepository;

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  repo = new ProviderRepository(driver);
  await driver.query(
    'INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)', ['p1', 'P'], 'run');
});

describe('accounts', () => {
  it('names the account and never the key', async () => {
    const a = await repo.addAccount({ kind: 'openrouter', label: 'My OpenRouter' });
    expect(a).toMatchObject({ kind: 'openrouter', credentialRef: null, dataPolicy: 'no_training', active: true });
    await repo.setCredentialRef(a.id, `cred-${a.id}`);
    const [row] = await repo.listAccounts();
    expect(row?.credentialRef).toBe(`cred-${a.id}`);
    const cols = (await driver.query('SELECT * FROM provider_account', [], 'all')).rows as unknown[][];
    expect(JSON.stringify(cols)).not.toMatch(/sk-/);
  });

  it('removes the profiles with the account', async () => {
    const a = await repo.addAccount({ kind: 'openrouter', label: 'x' });
    await repo.setProfile('p1', 'draft', { providerAccountId: a.id, modelId: 'm' });
    await repo.removeAccount(a.id);
    expect(await repo.listAccounts()).toEqual([]);
    expect(await repo.listProfiles('p1')).toEqual([]);
  });
});

describe('profiles', () => {
  it('keeps one overall default with no project, read by every project', async () => {
    const a = await repo.addAccount({ kind: 'openrouter', label: 'Mine' });
    await repo.setProfile(null, 'default', { providerAccountId: a.id, modelId: 'everything' });
    expect((await repo.listProfiles('p1')).map((p) => [p.role, p.modelId, p.projectId]))
      .toEqual([['default', 'everything', null]]);
    expect((await repo.listProfiles('p2')).map((p) => p.modelId)).toEqual(['everything']);
    await repo.setProfile(null, 'default', { providerAccountId: a.id, modelId: 'replaced' });
    expect((await repo.listProfiles('p2')).map((p) => p.modelId)).toEqual(['replaced']);
  });

  it('holds one per role per project, the project’s own over the default', async () => {
    const a = await repo.addAccount({ kind: 'openrouter', label: 'x' });
    await repo.setProfile(null, 'draft', { providerAccountId: a.id, modelId: 'default-model', contextWindow: 8000 });
    await repo.setProfile(null, 'summarise', { providerAccountId: a.id, modelId: 'cheap' });
    await repo.setProfile('p1', 'draft', { providerAccountId: a.id, modelId: 'strong', contextWindow: 200000, costInPerMtok: 3 });
    await repo.setProfile('p1', 'draft', { providerAccountId: a.id, modelId: 'stronger', contextWindow: 200000 });

    const profiles = await repo.listProfiles('p1');
    expect(profiles.map((p) => `${p.role}:${p.modelId}`).sort()).toEqual(['draft:stronger', 'summarise:cheap']);
    expect(profiles.find((p) => p.role === 'draft')?.contextWindow).toBe(200000);
  });

  it('keeps the worst reasoning spend seen', async () => {
    const a = await repo.addAccount({ kind: 'openrouter', label: 'x' });
    const p = await repo.setProfile('p1', 'draft', { providerAccountId: a.id, modelId: 'm' });
    await repo.recordReasoning(p.id, 900);
    await repo.recordReasoning(p.id, 300);
    expect((await repo.listProfiles('p1'))[0]?.reasoningAllowance).toBe(900);
  });
});
