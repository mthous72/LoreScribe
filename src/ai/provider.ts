/**
 * The provider abstraction — [doc 01 §"Provider abstraction"](../../docs/01-architecture.md).
 *
 * The app never calls a provider directly; it calls a *role*, and a role maps to
 * a `model_profile`, which names an account and a model. The adapter is the one
 * thing an account knows how to make, and everything above it — the budget, the
 * sanitiser, the run record — sees only these types. Local models are the same
 * interface pointed at an OpenAI-compatible endpoint, which is why the interface
 * is small and asks the model what it can do rather than assuming.
 *
 * **Everything streams and cancellation is real** ([doc 06](../../docs/06-ai-pipeline.md)).
 * `chat` is an async iterable of deltas; the caller passes an `AbortSignal`, and
 * when it fires the iteration ends normally with `finishReason: 'cancelled'`
 * rather than throwing, because *partial output is kept, not discarded* and a
 * thrown error is the shape of a result that was lost.
 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** `provider_account.data_policy`. Sent as a routing constraint where supported. */
export type DataPolicy = 'no_training' | 'zero_retention' | 'any';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Visible answer budget. The reasoning allowance is added on top, by the caller. */
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  dataPolicy?: DataPolicy;
}

export type ChatDelta =
  | { kind: 'text'; text: string }
  /** The private think channel, where the provider exposes it. Never shown as prose. */
  | { kind: 'reasoning'; text: string }
  | { kind: 'usage'; promptTokens: number; completionTokens: number; reasoningTokens: number }
  | {
    kind: 'done';
    finishReason: 'stop' | 'length' | 'content_filter' | 'cancelled' | 'error' | 'unknown';
    /** The upstream that actually served it — `ai_run.served_by`. */
    servedBy: string | null;
  };

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  /** USD per million tokens. Null when the provider does not say. */
  costInPerMtok: number | null;
  costOutPerMtok: number | null;
  /** Whether the upstream applies its own content moderation. */
  moderated: boolean;
  supportsTools: boolean;
  supportsJsonSchema: boolean;
}

export interface ModelCapabilities {
  contextWindow: number;
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  supportsStrictSchema: boolean;
  costIn: number | null;
  costOut: number | null;
  /** Learned per model — doc 12 §4. Zero until observed. */
  reasoningAllowance: number;
}

/** What a provider says about the key it was shown. Amounts in USD; null when not said. */
export interface KeyInfo {
  label: string | null;
  usage: number | null;
  limit: number | null;
  limitRemaining: number | null;
}

export interface ProviderAdapter {
  id: string;
  /**
   * Prove the credential, on an endpoint that requires it. Listing models is
   * not that on every provider — OpenRouter's is public — and a "test" that
   * passes with a made-up key is worse than none.
   */
  verify?(): Promise<KeyInfo>;
  listModels(): Promise<ModelInfo[]>;
  capabilities(modelId: string): ModelCapabilities;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>;
  embed?(texts: string[]): Promise<Float32Array[]>;
  countTokens(text: string, modelId: string): number;
}

export type ProviderErrorCode =
  /** The key was rejected. */
  | 'auth'
  /** The account is out of credit. */
  | 'credit'
  | 'rate-limit'
  /** The provider declined the content. `ai_run.status = 'refused'`. */
  | 'refused'
  /** The request was malformed — a model that does not exist, a bad parameter. */
  | 'bad-request'
  /** The provider failed. */
  | 'provider'
  /** No answer at all: offline, CORS, DNS. */
  | 'network';

/**
 * One error shape for every provider, so the UI has one thing to say for each
 * code rather than a message copied from whichever upstream failed.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
