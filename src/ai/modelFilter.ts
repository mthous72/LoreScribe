import type { ModelInfo } from './provider';

/**
 * The two filters a writer reaches for in a list of a few hundred models.
 *
 * **Free** is what the provider says it charges: nothing in and nothing out.
 * A model with no price stated is not free, it is unpriced, and stays out of
 * the free list rather than being guessed in.
 *
 * **Uncensored** is the provider\'s own flag inverted: OpenRouter marks a
 * model `moderated` when the upstream applies its own content filter before
 * the model sees the prompt. Unmoderated means only that gate is absent; the
 * model may still decline on its own, and the hard floor
 * ([D3](../../docs/10-decisions.md)) is unaffected either way.
 */
export interface ModelFilters {
  free: boolean;
  uncensored: boolean;
}

export const isFree = (m: ModelInfo): boolean => m.costInPerMtok === 0 && m.costOutPerMtok === 0;

export function filterModels(models: readonly ModelInfo[], filters: ModelFilters): ModelInfo[] {
  return models.filter((m) => (!filters.free || isFree(m)) && (!filters.uncensored || !m.moderated));
}

/** A model's price for a typical call, in and out added; null when the provider does not say. */
export const priceOf = (m: ModelInfo): number | null =>
  (m.costInPerMtok === null || m.costOutPerMtok === null ? null : m.costInPerMtok + m.costOutPerMtok);

/** Cheapest first; the unpriced last, since "unknown" is not "free"; ties by name. */
export function sortByPrice(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const pa = priceOf(a);
    const pb = priceOf(b);
    if (pa === null && pb === null) return a.name.localeCompare(b.name, 'en');
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb || a.name.localeCompare(b.name, 'en');
  });
}
