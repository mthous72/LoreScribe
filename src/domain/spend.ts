/**
 * Spend caps — the runaway-loop guard, not a budget ([D17](../../docs/10-decisions.md)).
 *
 * Two per-project numbers, both per local calendar day: a **warning** the
 * panel shows and drafting continues past, and a **stop** that refuses the
 * call before it is made. The defaults are conservative on purpose ($5 and
 * $20), and D17 expects the stop to be raised the first time it gets in the
 * way of real work, so raising it is one tap from the meter that fired.
 *
 * The day is the device's local day, because "today" to a writer means since
 * they woke up, not since midnight UTC. Everything here is pure; the sums come
 * from `ai_run` through the repository.
 */

export interface SpendCaps {
  /** Show a warning once today's spend reaches this. */
  warnUsd: number;
  /** Refuse to start a run once today's spend reaches this. */
  stopUsd: number;
}

export type SpendLevel = 'ok' | 'warn' | 'stop';

export interface SpendMeter {
  /** USD spent on this project since local midnight. */
  todayUsd: number;
  /** Runs today that used tokens but had no price on their profile, so they are not in the sum. */
  unpricedRuns: number;
  caps: SpendCaps;
  level: SpendLevel;
  /** Local midnight, epoch ms. */
  dayStart: number;
}

export const DEFAULT_CAPS: SpendCaps = { warnUsd: 5, stopUsd: 20 };

/** Local midnight before `now`. */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** At the line counts as over it: a stop of $20 stops the run that would follow $20. */
export function spendLevel(todayUsd: number, caps: SpendCaps): SpendLevel {
  if (todayUsd >= caps.stopUsd) return 'stop';
  if (todayUsd >= caps.warnUsd) return 'warn';
  return 'ok';
}

/** The caps as saved, or the reasons they cannot be. */
export function validateCaps(caps: SpendCaps): SpendCaps {
  const warnUsd = Number(caps.warnUsd);
  const stopUsd = Number(caps.stopUsd);
  if (!Number.isFinite(warnUsd) || warnUsd < 0) throw new Error('The warning must be a dollar amount, zero or more.');
  if (!Number.isFinite(stopUsd) || stopUsd < 0) throw new Error('The stop must be a dollar amount, zero or more.');
  if (warnUsd > stopUsd) throw new Error('The warning cannot be higher than the stop.');
  return { warnUsd: round(warnUsd), stopUsd: round(stopUsd) };
}

/** The one-tap raise: double the stop, never by less than five dollars. */
export function raisedStop(stopUsd: number): number {
  return round(Math.max(stopUsd * 2, stopUsd + 5));
}

/** Caps from `project.settings_json`; the defaults stand in for anything missing or malformed. */
export function capsFromSettings(settingsJson: string | null): SpendCaps {
  if (!settingsJson) return { ...DEFAULT_CAPS };
  let parsed: unknown;
  try { parsed = JSON.parse(settingsJson); } catch { return { ...DEFAULT_CAPS }; }
  const spend = (parsed as { spend?: Partial<SpendCaps> } | null)?.spend;
  const pick = (v: unknown, fallback: number) =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const caps = {
    warnUsd: pick(spend?.warnUsd, DEFAULT_CAPS.warnUsd), stopUsd: pick(spend?.stopUsd, DEFAULT_CAPS.stopUsd),
  };
  return caps.warnUsd > caps.stopUsd ? { ...DEFAULT_CAPS } : caps;
}

/** `settings_json` with the spend caps replaced and every other key kept. */
export function settingsWithCaps(settingsJson: string | null, caps: SpendCaps): string {
  let parsed: Record<string, unknown> = {};
  if (settingsJson) {
    try {
      const value = JSON.parse(settingsJson) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { /* an unreadable settings blob is replaced rather than propagated */ }
  }
  return JSON.stringify({ ...parsed, spend: { warnUsd: caps.warnUsd, stopUsd: caps.stopUsd } });
}

/** Whole cents. */
function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** `$1.23`, or `$0.0042` when the amount is below a cent and not nothing. */
export function usd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
