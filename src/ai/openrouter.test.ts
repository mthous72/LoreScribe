import { describe, it, expect } from 'vitest';
import { OpenRouterAdapter, mapError } from './openrouter';
import { ProviderError, type ChatDelta } from './provider';

/**
 * The adapter against recorded response shapes, with `fetch` faked.
 *
 * Bodies are delivered as streams cut at awkward points, because that is the
 * only thing about streaming that is hard: an event straddling a chunk, a
 * multi-byte character straddling a chunk. The live spike — CORS, real
 * cancellation, real error shapes — is the "Test this key" button; nothing
 * here claims to be that.
 */

const encoder = new TextEncoder();

/** A Response whose body arrives as these chunks, in order. */
function streamed(chunks: (string | Uint8Array)[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

const sse = (objects: unknown[]) =>
  [...objects.map((o) => `data: ${JSON.stringify(o)}\n\n`), 'data: [DONE]\n\n'].join('');

const delta = (content: string, extra: Record<string, unknown> = {}) => ({
  id: 'gen-1', provider: 'Anthropic',
  choices: [{ delta: { content }, finish_reason: null }], ...extra,
});

interface Captured { url: string; init: RequestInit }

function adapter(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    return respond(c);
  };
  return { calls, adapter: new OpenRouterAdapter({ apiKey: 'sk-test', fetch: fetchFake, title: 'LoreScribe' }) };
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

const request = {
  model: 'anthropic/claude-3.5-sonnet',
  messages: [{ role: 'user' as const, content: 'Go.' }],
  maxTokens: 100,
};

describe('the request', () => {
  it('sends the key, the attribution headers, streaming, usage and the routing constraint', async () => {
    const { calls, adapter: a } = adapter(() => streamed([sse([delta('x')])]));
    await collect(a.chat(request, new AbortController().signal));
    const [c] = calls;
    expect(c?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = c?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['X-Title']).toBe('LoreScribe');
    const body = JSON.parse(c?.init.body as string);
    expect(body).toMatchObject({
      model: request.model, stream: true, max_tokens: 100, usage: { include: true },
      provider: { data_collection: 'deny' },
    });
  });

  it('sends no constraint for the explicit opt-in, and narrows for zero retention', async () => {
    const { calls, adapter: a } = adapter(() => streamed([sse([delta('x')])]));
    await collect(a.chat({ ...request, dataPolicy: 'any' }, new AbortController().signal));
    await collect(a.chat({ ...request, dataPolicy: 'zero_retention' }, new AbortController().signal));
    expect(JSON.parse(calls[0]?.init.body as string).provider).toBeUndefined();
    expect(JSON.parse(calls[1]?.init.body as string).provider)
      .toEqual({ data_collection: 'deny', zdr: true });
  });
});

describe('the stream', () => {
  const chunks = [
    delta('The '), delta('rain '),
    delta('came in.', { choices: [{ delta: { content: 'came in.' }, finish_reason: 'stop' }] }),
    { id: 'gen-1', provider: 'Anthropic', choices: [{ delta: {}, finish_reason: null }],
      usage: {
        prompt_tokens: 12, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 },
      } },
  ];

  it('yields the text as it lands, then usage, then done with who served it', async () => {
    const { adapter: a } = adapter(() => streamed([sse(chunks)]));
    const out = await collect(a.chat(request, new AbortController().signal));
    expect(out).toEqual([
      { kind: 'text', text: 'The ' },
      { kind: 'text', text: 'rain ' },
      { kind: 'text', text: 'came in.' },
      { kind: 'usage', promptTokens: 12, completionTokens: 4, reasoningTokens: 0 },
      { kind: 'done', finishReason: 'stop', servedBy: 'Anthropic' },
    ]);
  });

  it('gives the same answer however the bytes were cut, a multi-byte character included', async () => {
    const whole = sse([
      delta('café — '),
      delta('done.', { choices: [{ delta: { content: 'done.' }, finish_reason: 'stop' }] }),
    ]);
    const bytes = encoder.encode(whole);
    const expected = await collect(
      adapter(() => streamed([whole])).adapter.chat(request, new AbortController().signal));
    expect(expected.filter((d) => d.kind === 'text').map((d) => (d as { text: string }).text).join(''))
      .toBe('café — done.');
    for (const cut of [1, 5, 9, 17, 18, 19, 20, 40, bytes.length - 3]) {
      const { adapter: a } = adapter(() => streamed([bytes.slice(0, cut), bytes.slice(cut)]));
      expect(await collect(a.chat(request, new AbortController().signal))).toEqual(expected);
    }
  });

  it('separates the think channel from the prose and learns the worst reasoning spend', async () => {
    const { adapter: a } = adapter(() => streamed([sse([
      { choices: [{ delta: { reasoning: 'Let me think.' }, finish_reason: null }] },
      delta('Answer.', { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] }),
      { choices: [{ delta: {}, finish_reason: null }],
        usage: {
          prompt_tokens: 5, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 850 },
        } },
    ])]));
    const out = await collect(a.chat(request, new AbortController().signal));
    expect(out[0]).toEqual({ kind: 'reasoning', text: 'Let me think.' });
    expect(out.find((d) => d.kind === 'text')).toEqual({ kind: 'text', text: 'Answer.' });
    expect(a.observedReasoning.get(request.model)).toBe(850);
    expect(a.capabilities(request.model).reasoningAllowance).toBe(850);
  });

  it('ends normally on cancellation and keeps what arrived', async () => {
    // A body that never closes on its own: the only way out is the signal.
    let release: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta('First. '))}\n\n`));
        release = () => controller.close();
      },
    });
    const { adapter: a } = adapter(() => new Response(body, { status: 200 }));
    const ctl = new AbortController();
    const out: ChatDelta[] = [];
    for await (const d of a.chat(request, ctl.signal)) {
      out.push(d);
      if (d.kind === 'text') { ctl.abort(); release(); }
    }
    expect(out).toEqual([
      { kind: 'text', text: 'First. ' },
      { kind: 'done', finishReason: 'cancelled', servedBy: 'Anthropic' },
    ]);
  });

  it('reports a mid-stream error as the provider’s, naming the upstream', async () => {
    const { adapter: a } = adapter(() => streamed([sse([
      delta('Part'),
      { error: { code: 502, message: 'Upstream fell over', metadata: { provider_name: 'SomeLab' } } },
    ])]));
    const got: ChatDelta[] = [];
    const drain = async () => {
      for await (const d of a.chat(request, new AbortController().signal)) got.push(d);
    };
    await expect(drain())
      .rejects.toMatchObject({ name: 'ProviderError', code: 'provider', message: 'Upstream fell over (SomeLab)' });
    expect(got).toEqual([{ kind: 'text', text: 'Part' }]);
  });
});

describe('the error vocabulary', () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    adapter(() => new Response(JSON.stringify(body), { status, headers })).adapter;

  it('maps the statuses the UI has words for', async () => {
    const cases: [number, string][] = [
      [401, 'auth'], [402, 'credit'], [403, 'refused'],
      [429, 'rate-limit'], [400, 'bad-request'], [500, 'provider'],
    ];
    for (const [status, code] of cases) {
      const a = failing(status, { error: { message: `status ${status}` } });
      await expect(collect(a.chat(request, new AbortController().signal)))
        .rejects.toMatchObject({ code, status, message: `status ${status}` });
    }
  });

  it('carries retry-after on a rate limit', async () => {
    const a = failing(429, { error: { message: 'slow down' } }, { 'retry-after': '7' });
    await expect(collect(a.chat(request, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'rate-limit', retryAfterMs: 7000 });
  });

  it('calls a fetch that rejects a network error, not a provider one', async () => {
    const a = new OpenRouterAdapter({ apiKey: 'k', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(collect(a.chat(request, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'network', message: 'Failed to fetch' });
  });

  it('is one class', () => {
    expect(mapError(401, 'no', null)).toBeInstanceOf(ProviderError);
  });
});

describe('the model list', () => {
  it('reads windows and prices, and remembers them for capabilities()', async () => {
    const { adapter: a } = adapter(() => new Response(JSON.stringify({ data: [{
      id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      top_provider: { context_length: 200000, is_moderated: true },
      supported_parameters: ['tools', 'response_format', 'temperature'],
    }, { id: 'meta-llama/llama-3-8b', pricing: {} }] }), { status: 200 }));
    const models = await a.listModels();
    expect(models[0]).toEqual({
      id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000,
      costInPerMtok: 3, costOutPerMtok: 15, moderated: true, supportsTools: true, supportsJsonSchema: true,
    });
    expect(models[1]).toMatchObject({ name: 'meta-llama/llama-3-8b', contextWindow: 0, costInPerMtok: null });
    expect(a.capabilities('anthropic/claude-3.5-sonnet')).toMatchObject({ contextWindow: 200000, costIn: 3 });
    expect(a.capabilities('nobody/nothing').contextWindow).toBe(0);
  });
});
