import type { ModelProfile, ProfileRole, ProviderAccount, ProviderRepository } from '../data/providerRepository';
import type { RunsRepository } from '../data/runsRepository';
import type { SpendRepository } from '../data/spendRepository';
import { usd, type SpendMeter } from '../domain/spend';
import { OpenRouterAdapter } from './openrouter';
import type { ProviderAdapter } from './provider';

/**
 * What every caller of a model role does before the call.
 *
 * The app calls a *role*, not a model ([doc 06](../../docs/06-ai-pipeline.md)):
 * the role names a profile, the profile names an account, the account makes
 * the adapter. And before any of that, the spend meter
 * ([D17](../../docs/10-decisions.md)) — the one check that holds whatever
 * else is missing, so it comes first and is shared here rather than restated
 * by each pipeline step.
 */

/** No profile for the role, or its account is gone or switched off. The panel turns this into a link. */
export class NoModelError extends Error {
  constructor(readonly role: ProfileRole) {
    super(`No ${role} model is set for this project. Choose one on the Providers page.`);
    this.name = 'NoModelError';
  }
}

/** Today's spend has reached the project's stop. The meter says by how much; the panel offers the raise. */
export class SpendCapError extends Error {
  constructor(readonly meter: SpendMeter) {
    super(`${usd(meter.todayUsd)} spent today on this project has reached the ${usd(meter.caps.stopUsd)} daily stop, `
      + 'so nothing was sent.');
    this.name = 'SpendCapError';
  }
}

export interface Resolved {
  profile: ModelProfile;
  account: ProviderAccount;
}

export async function resolveRole(
  providers: ProviderRepository, projectId: string, role: ProfileRole,
): Promise<Resolved> {
  const profile = (await providers.listProfiles(projectId)).find((p) => p.role === role);
  if (!profile) throw new NoModelError(role);
  const account = (await providers.listAccounts()).find((a) => a.id === profile.providerAccountId);
  if (!account || !account.active) throw new NoModelError(role);
  return { profile, account };
}

/**
 * Refuse at the stop, and record that it was asked for: a `blocked` run with
 * the reason, no cost, so the refusal never counts toward the spend it was
 * blocked for.
 */
export async function guardSpend(
  deps: { spend: SpendRepository; runs: RunsRepository },
  projectId: string, sceneId: string | null, purpose: string,
): Promise<SpendMeter> {
  const meter = await deps.spend.meter(projectId);
  if (meter.level === 'stop') {
    const error = new SpendCapError(meter);
    await deps.runs.block(projectId, {
      sceneId, purpose, provider: null, model: null, reason: error.message,
    });
    throw error;
  }
  return meter;
}

export function defaultAdapter(account: ProviderAccount, apiKey: string): ProviderAdapter {
  if (account.kind !== 'openrouter') {
    throw new Error(`${account.kind} accounts cannot be called yet; only OpenRouter can.`);
  }
  return new OpenRouterAdapter({
    apiKey, baseUrl: account.baseUrl ?? undefined,
    referer: typeof window === 'undefined' ? undefined : window.location.origin, title: 'LoreScribe',
  });
}

/** Cost from the provider's counts against the profile's prices, or null when the profile has none. */
export function costOf(
  profile: ModelProfile, usage: { tokensIn: number; tokensOut: number } | null,
): number | null {
  if (!usage || profile.costInPerMtok === null || profile.costOutPerMtok === null) return null;
  return (usage.tokensIn * profile.costInPerMtok + usage.tokensOut * profile.costOutPerMtok) / 1_000_000;
}
