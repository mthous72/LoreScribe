import {
  ProviderError,
  type ChatDelta, type ChatRequest, type DataPolicy, type ModelCapabilities, type ModelInfo,
  type ProviderAdapter,
} from './provider';
import { SseParser } from './sse';
import { estimateTokens } from '../domain/briefBudget';

/**
 * OpenRouter, called directly from the browser with the writer's own key
 * ([D2](../../docs/10-decisions.md), [D6](../../docs/10-decisions.md)).
 *
 * `fetch` is injected. The adapter is tested against recorded response shapes
 * cut at awkward chunk boundaries, and the one thing a unit test cannot show —
 * that the browser is allowed to make the call at all — is the spike doc 08
 * names: CORS, cancellation and error shapes against the live endpoint. That is
 * the "Test this key" button on the providers screen, so the spike is one click
 * with a real key rather than a script somebody has to run.
 *
 * **The data policy travels as a routing constraint** ([doc 13](../../docs/13-legal-and-compliance.md)).
 * `no_training` becomes `provider.data_collection = 'deny'`, which tells the
 * router to skip upstreams that may train on inputs; `zero_retention` narrows
 * further. `any` sends nothing and is the explicit opt-in. Which upstream
 * actually served the request comes back on the response and is surfaced as
 * `servedBy`, so *where has my book been sent* stays a query.
 *
 * **Errors are mapped to one small vocabulary** — a rejected key, no credit, a
 * rate limit, a refusal, a bad request, a provider fault, no network — because
 * the UI needs one thing to say for each, and a message copied from whichever
 * upstream failed is not that. A refusal is not an error in the same sense: it
 * is recorded on the run as `refused`, and the writer is told which upstream
 * declined so they can route elsewhere ([doc 04](../../docs/04-laws-engine.md)).
 */

export interface OpenRouterOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Sent as `HTTP-Referer` and `X-Title`, which OpenRouter uses for attribution. */
  referer?: string;
  title?: string;
}

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number; is_moderated?: boolean };
  supported_parameters?: string[];
}

interface RawChunk {
  choices?: {
    delta?: { content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  provider?: string;
  error?: { code?: number | string; message?: string; metadata?: { provider_name?: string } };
}

/** USD per token as a string on the wire → USD per million tokens, or null. */
const perMtok = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n * 1_000_000 : null;
};

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter';
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #headers: Record<string, string>;
  #models = new Map<string, ModelInfo>();
  /** Worst reasoning spend seen per model this session — doc 12 §4. */
  readonly observedReasoning = new Map<string, number>();

  constructor(options: OpenRouterOptions) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.#headers = {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      ...(options.referer ? { 'HTTP-Referer': options.referer } : {}),
      ...(options.title ? { 'X-Title': options.title } : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.#call(`${this.#base}/models`, { method: 'GET', headers: this.#headers });
    const body = (await res.json()) as { data?: RawModel[] };
    const models = (body.data ?? []).map((m): ModelInfo => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.top_provider?.context_length ?? m.context_length ?? 0,
      costInPerMtok: perMtok(m.pricing?.prompt),
      costOutPerMtok: perMtok(m.pricing?.completion),
      moderated: m.top_provider?.is_moderated ?? false,
      supportsTools: m.supported_parameters?.includes('tools') ?? false,
      supportsJsonSchema: m.supported_parameters?.includes('response_format') ?? false,
    }));
    this.#models = new Map(models.map((m) => [m.id, m]));
    return models;
  }

  capabilities(modelId: string): ModelCapabilities {
    const m = this.#models.get(modelId);
    return {
      contextWindow: m?.contextWindow ?? 0,
      supportsTools: m?.supportsTools ?? false,
      supportsJsonSchema: m?.supportsJsonSchema ?? false,
      supportsStrictSchema: false,
      costIn: m?.costInPerMtok ?? null,
      costOut: m?.costOutPerMtok ?? null,
      reasoningAllowance: this.observedReasoning.get(modelId) ?? 0,
    };
  }

  /** The budget's placeholder estimate. A per-model counter is the second spike. */
  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body = {
      model: req.model,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.stop ? { stop: req.stop } : {}),
      // Usage on the final chunk, so tokens and cost are recorded from the
      // provider's count rather than our estimate.
      usage: { include: true },
      ...routing(req.dataPolicy),
    };

    let res: Response;
    try {
      res = await this.#call(`${this.#base}/chat/completions`, {
        method: 'POST', headers: this.#headers, body: JSON.stringify(body), signal,
      });
    } catch (e) {
      if (signal.aborted) { yield { kind: 'done', finishReason: 'cancelled', servedBy: null }; return; }
      throw e;
    }
    if (!res.body) throw new ProviderError('provider', 'The provider sent no body.', res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let servedBy: string | null = null;
    let finish: ChatDelta & { kind: 'done' } | null = null;
    let reasoningSeen = 0;

    const handle = (data: string): ChatDelta[] => {
      if (data === '[DONE]') return [];
      let chunk: RawChunk;
      try { chunk = JSON.parse(data) as RawChunk; } catch { return []; }
      if (chunk.error) {
        // A mid-stream error arrives as data, with a 200 already sent.
        throw mapError(Number(chunk.error.code) || 0, chunk.error.message ?? 'The provider reported an error.',
          chunk.error.metadata?.provider_name ?? null);
      }
      const out: ChatDelta[] = [];
      if (chunk.provider) servedBy = chunk.provider;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.reasoning) {
        reasoningSeen += chunk.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        out.push({ kind: 'reasoning', text: choice.delta.reasoning });
      }
      if (choice?.delta?.content) out.push({ kind: 'text', text: choice.delta.content });
      if (chunk.usage) {
        const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        reasoningSeen = Math.max(reasoningSeen, reasoning);
        out.push({
          kind: 'usage',
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          reasoningTokens: reasoning,
        });
      }
      if (choice?.finish_reason) {
        finish = { kind: 'done', finishReason: finishOf(choice.finish_reason), servedBy };
      }
      return out;
    };

    try {
      for (;;) {
        if (signal.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          for (const d of handle(ev.data)) yield d;
        }
      }
      if (!signal.aborted) {
        for (const ev of parser.end()) for (const d of handle(ev.data)) yield d;
      }
    } catch (e) {
      if (!signal.aborted) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError('network', (e as Error).message ?? 'The connection was lost.');
      }
    } finally {
      // Cancel the underlying stream, whichever way we left the loop. Ignore a
      // reader that is already closed.
      await reader.cancel().catch(() => undefined);
    }

    if (reasoningSeen > 0) {
      const worst = Math.max(this.observedReasoning.get(req.model) ?? 0, reasoningSeen);
      this.observedReasoning.set(req.model, worst);
    }
    if (signal.aborted) yield { kind: 'done', finishReason: 'cancelled', servedBy };
    else yield finish ?? { kind: 'done', finishReason: 'unknown', servedBy };
  }

  async #call(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted) throw e;
      // A rejected fetch is the browser refusing to make the call at all — no
      // network, a CORS refusal, DNS. There is no status to map.
      throw new ProviderError('network', (e as Error).message ?? 'No response from the provider.');
    }
    if (res.ok) return res;
    let message = `${res.status} ${res.statusText}`.trim();
    let upstream: string | null = null;
    try {
      const body = (await res.json()) as RawChunk;
      message = body.error?.message ?? message;
      upstream = body.error?.metadata?.provider_name ?? null;
    } catch { /* not JSON; keep the status line */ }
    const retry = res.headers.get('retry-after');
    throw mapError(res.status, message, upstream, retry ? Number(retry) * 1000 : null);
  }
}

/** The routing constraint each data policy becomes. */
function routing(policy: DataPolicy | undefined): Record<string, unknown> {
  switch (policy) {
    case undefined:
    case 'no_training': return { provider: { data_collection: 'deny' } };
    // `zdr` is OpenRouter's zero-data-retention routing flag. Its exact name is
    // what the live spike confirms; the intent is recorded here either way.
    case 'zero_retention': return { provider: { data_collection: 'deny', zdr: true } };
    case 'any': return {};
  }
}

function finishOf(reason: string): (ChatDelta & { kind: 'done' })['finishReason'] {
  switch (reason) {
    case 'stop': case 'end_turn': return 'stop';
    case 'length': case 'max_tokens': return 'length';
    case 'content_filter': return 'content_filter';
    case 'error': return 'error';
    default: return 'unknown';
  }
}

export function mapError(
  status: number, message: string, upstream: string | null, retryAfterMs: number | null = null,
): ProviderError {
  const said = upstream ? `${message} (${upstream})` : message;
  switch (status) {
    case 401: return new ProviderError('auth', said, status);
    case 402: return new ProviderError('credit', said, status);
    case 403: return new ProviderError('refused', said, status);
    case 429: return new ProviderError('rate-limit', said, status, retryAfterMs);
    case 400: case 404: case 422: return new ProviderError('bad-request', said, status);
    default:
      return status >= 500 || status === 0 || status === 408 || status === 502 || status === 503
        ? new ProviderError('provider', said, status, retryAfterMs)
        : new ProviderError('provider', said, status);
  }
}
