import type { SqlDriver } from '../db/driver';
import { uuidv7 } from './ids';
import type { DataPolicy } from '../ai/provider';

/**
 * Accounts and the roles that use them.
 *
 * A `provider_account` is where the key is *named*, never where it is kept —
 * `credential_ref` is a handle into the credential store
 * ([D30](../../docs/10-decisions.md)) and the row is already excluded from the
 * archive export. A `model_profile` binds a role (`draft`, `summarise`, …) to
 * an account and a model, with the model's window and prices copied in when it
 * was chosen: the budget needs the window before any call is made, and prices
 * change, so the number the run was costed against is the number kept.
 */

export type AccountKind = 'openrouter' | 'ollama' | 'llamacpp' | 'lmstudio' | 'openai_compat';
/**
 * The jobs the app calls, plus `default`: the model every job uses when it
 * has none of its own. Set with `projectId = null` it is the one overall
 * choice, kept for every project; a role set for a project overrides it.
 */
export type ProfileRole =
  | 'default' | 'draft' | 'revise' | 'critique' | 'summarise' | 'extract' | 'embed' | 'name';

export interface ProviderAccount {
  id: string;
  kind: AccountKind;
  label: string;
  baseUrl: string | null;
  /** Null until a key has been saved for it. */
  credentialRef: string | null;
  dataPolicy: DataPolicy;
  active: boolean;
}

export interface ModelProfile {
  id: string;
  projectId: string | null;
  role: ProfileRole;
  providerAccountId: string;
  modelId: string;
  contextWindow: number | null;
  costInPerMtok: number | null;
  costOutPerMtok: number | null;
  reasoningAllowance: number;
}

export interface ProfileDraft {
  providerAccountId: string;
  modelId: string;
  contextWindow?: number | null;
  costInPerMtok?: number | null;
  costOutPerMtok?: number | null;
}

export class ProviderRepository {
  constructor(private readonly driver: SqlDriver) {}

  async #all(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return (await this.driver.query(sql, params, 'all')).rows as unknown[][];
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    const rows = await this.#all(
      `SELECT id, kind, label, base_url, credential_ref, data_policy, active
       FROM provider_account ORDER BY created_at`);
    return rows.map((r) => ({
      id: r[0] as string, kind: r[1] as AccountKind, label: r[2] as string,
      baseUrl: r[3] as string | null, credentialRef: r[4] as string | null,
      dataPolicy: r[5] as DataPolicy, active: Number(r[6]) !== 0,
    }));
  }

  async addAccount(draft: {
    kind: AccountKind; label: string; baseUrl?: string | null; dataPolicy?: DataPolicy;
  }): Promise<ProviderAccount> {
    const now = Date.now();
    const account: ProviderAccount = {
      id: uuidv7(now), kind: draft.kind, label: draft.label, baseUrl: draft.baseUrl ?? null,
      credentialRef: null, dataPolicy: draft.dataPolicy ?? 'no_training', active: true,
    };
    await this.driver.query(
      `INSERT INTO provider_account (id, kind, label, base_url, credential_ref, data_policy, active,
                                     created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
      [account.id, account.kind, account.label, account.baseUrl, account.dataPolicy, now, now], 'run');
    return account;
  }

  /** The handle, never the key. */
  async setCredentialRef(accountId: string, ref: string | null): Promise<void> {
    await this.driver.query(
      'UPDATE provider_account SET credential_ref = ?, updated_at = ? WHERE id = ?',
      [ref, Date.now(), accountId], 'run');
  }

  async setDataPolicy(accountId: string, policy: DataPolicy): Promise<void> {
    await this.driver.query(
      'UPDATE provider_account SET data_policy = ?, updated_at = ? WHERE id = ?',
      [policy, Date.now(), accountId], 'run');
  }

  /** Removes the account and every profile that pointed at it. The key is the caller's to forget. */
  async removeAccount(accountId: string): Promise<void> {
    await this.driver.batch([
      { sql: 'DELETE FROM model_profile WHERE provider_account_id = ?', params: [accountId] },
      { sql: 'DELETE FROM provider_account WHERE id = ?', params: [accountId] },
    ], true);
  }

  /** Profiles for a project, with the project-less defaults where the project has none. */
  async listProfiles(projectId: string): Promise<ModelProfile[]> {
    const rows = await this.#all(
      `SELECT id, project_id, role, provider_account_id, model_id, context_window,
              cost_in_per_mtok, cost_out_per_mtok, reasoning_allowance
       FROM model_profile WHERE project_id = ? OR project_id IS NULL
       ORDER BY role, project_id IS NULL`, [projectId]);
    const byRole = new Map<string, ModelProfile>();
    for (const r of rows) {
      const p: ModelProfile = {
        id: r[0] as string, projectId: r[1] as string | null, role: r[2] as ProfileRole,
        providerAccountId: r[3] as string, modelId: r[4] as string,
        contextWindow: r[5] === null ? null : Number(r[5]),
        costInPerMtok: r[6] === null ? null : Number(r[6]),
        costOutPerMtok: r[7] === null ? null : Number(r[7]),
        reasoningAllowance: Number(r[8] ?? 0),
      };
      // Ordered project-specific first, so the first row per role wins.
      if (!byRole.has(p.role)) byRole.set(p.role, p);
    }
    return [...byRole.values()];
  }

  /** One profile per role per project: setting it again replaces it. */
  async setProfile(projectId: string | null, role: ProfileRole, draft: ProfileDraft): Promise<ModelProfile> {
    const now = Date.now();
    const profile: ModelProfile = {
      id: uuidv7(now), projectId, role, providerAccountId: draft.providerAccountId,
      modelId: draft.modelId, contextWindow: draft.contextWindow ?? null,
      costInPerMtok: draft.costInPerMtok ?? null, costOutPerMtok: draft.costOutPerMtok ?? null,
      reasoningAllowance: 0,
    };
    await this.driver.batch([
      {
        sql: projectId === null
          ? 'DELETE FROM model_profile WHERE role = ? AND project_id IS NULL'
          : 'DELETE FROM model_profile WHERE role = ? AND project_id = ?',
        params: projectId === null ? [role] : [role, projectId],
      },
      {
        sql: `INSERT INTO model_profile (id, project_id, role, provider_account_id, model_id,
                                         context_window, cost_in_per_mtok, cost_out_per_mtok,
                                         reasoning_allowance, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        params: [profile.id, projectId, role, profile.providerAccountId, profile.modelId,
          profile.contextWindow, profile.costInPerMtok, profile.costOutPerMtok, now, now],
      },
    ], true);
    return profile;
  }

  /** Doc 12 §4: the worst reasoning spend seen, kept so it can be added up front. */
  async recordReasoning(profileId: string, observed: number): Promise<void> {
    await this.driver.query(
      `UPDATE model_profile SET reasoning_allowance = MAX(reasoning_allowance, ?), updated_at = ?
       WHERE id = ?`, [observed, Date.now(), profileId], 'run');
  }
}
