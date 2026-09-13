# Architecture

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Code sharing | **React + TypeScript + Vite, wrapped by Capacitor** | One UI, one data layer, ships as an installable PWA and a sideloaded Android APK ([D7](10-decisions.md)). Keeps us in the JS/TS ecosystem where the editor (ProseMirror) and AI SDKs live. |
| Source of truth | **Local-first SQLite on device** | Works offline, no hosting, no content liability, no account wall. The manuscript never leaves the device unless the writer exports or sends it to a provider. |
| AI access | **Writer's own API key, called directly** | No proxy to pay for or police. Local models drop into the same adapter. |
| Sync | **Not in v1, but schema is sync-ready** | `rev`, soft deletes and `op_log` from the first commit. Optional sync later is a feature, not a rewrite. |

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ UI            React + Tailwind + shadcn/ui (Radix)       │
│               Tiptap editor · TanStack Virtual · D3 for  │
│               arc/timeline/relationship views            │
├──────────────────────────────────────────────────────────┤
│ App state     Zustand stores + TanStack Query over the   │
│               repository layer (query keys = table+id)   │
├──────────────────────────────────────────────────────────┤
│ Domain        StoryGraph · SceneBriefCompiler ·          │
│               LawsEngine · ContinuityChecker ·           │
│               ArcPlanner · ExtractionService             │
│               (pure TypeScript, zero I/O, fully testable)│
├──────────────────────────────────────────────────────────┤
│ AI            ProviderRegistry → ProviderAdapter         │
│               OpenRouter · OpenAI-compatible (Ollama,    │
│               llama.cpp, LM Studio) · local embeddings   │
├──────────────────────────────────────────────────────────┤
│ Data          Repositories → Drizzle ORM → SQLite        │
│               web: @sqlite.org/sqlite-wasm over OPFS     │
│               android: @capacitor-community/sqlite       │
└──────────────────────────────────────────────────────────┘
```

**The domain layer must not import anything platform-specific.** The Scene Brief
Compiler and Laws Engine take plain objects and return plain objects. That is what
makes them unit-testable without a browser, and it is where the product's value
actually lives.

## Storage: one SQL dialect, two engines

`@sqlite.org/sqlite-wasm` with OPFS on the web and `@capacitor-community/sqlite`
on Android both speak SQLite, so Drizzle sits over a thin `SqlDriver` interface
with two implementations. Migrations are plain numbered `.sql` files applied in a
transaction at startup. Consequences worth knowing up front:

- Run SQLite in a web worker so long queries don't jank the editor.
- Large prose blobs are fine in SQLite; media (portraits, maps) go to OPFS /
  Capacitor Filesystem with only a URI in the row.

### Hosting and the cross-origin-isolation trap

The app is served as a static PWA (GitHub Pages is the obvious host — the app is
just code, the data never leaves the device). Static hosts **cannot set response
headers**, and the SharedArrayBuffer-based OPFS VFS requires cross-origin isolation
(`COOP: same-origin`, `COEP: require-corp`) because it uses `Atomics.wait` in a
worker. So that VFS is unavailable.

The intended path is the **`opfs-sahpool` VFS**, which uses a pre-opened pool of
sync access handles and needs no cross-origin isolation. **This is the first Phase 0
spike** — it gates the storage layer, so confirm it before building on it. Fallbacks
in order: a service-worker COI shim, then revisiting the no-desktop-wrapper decision
(a Tauri shell has no such constraint).

### Storage durability — the one real risk of local-first

OPFS and IndexedDB are **evictable**. The browser may reclaim them under storage
pressure, and the thing at stake is an entire novel. There is no server copy,
because that was the point. So:

- Call `navigator.storage.persist()` when the first project is created, and show
  the writer the honest answer if it's refused rather than assuming success.
- **Scheduled automatic backup export is a Phase 1 requirement, not a backlog
  item.** An evicted database with no recent export is total loss.
- Android keeps Capacitor specifically for this: native SQLite writes to
  app-private storage, which is not evictable. That is the only reason Capacitor
  survives in a project that ships to no store.

## Provider abstraction

```ts
interface ProviderAdapter {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  capabilities(modelId: string): ModelCapabilities;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>;
  embed?(texts: string[]): Promise<Float32Array[]>;
  countTokens(text: string, modelId: string): number;
}

interface ModelCapabilities {
  contextWindow: number;
  supportsTools: boolean;
  supportsJsonSchema: boolean;    // grammar-constrained decoding on llama.cpp
  supportsStrictSchema: boolean;  // needs all-closed objects
  costIn: number; costOut: number;
  reasoningAllowance: number;     // learned; see below
}
```

**Reasoning allowance is part of the capability model, not an afterthought.**
Reasoning models spend tokens in a private think channel *before* answering —
measured at ~2,500 tokens for a two-sentence request. A budget sized for the
answer gets eaten and the content comes back empty or truncated. The adapter
records observed `reasoning_tokens` per model, keeps the worst case, adds it
preemptively to later requests, and escalates up to twice on truncation. Streaming
cannot retry, so the allowance is applied up front there. (Learned from
LibriScribe — see [doc 09](09-libriscribe-review.md).)

## The sanitation layer

Every span of generated prose passes through a deterministic, idempotent,
pure-function pipeline before it is stored or displayed: `<think>`/`<reasoning>`
block stripping (with a streaming state machine, because the tags straddle chunk
boundaries), mojibake repair, scene-label and summary-echo removal, dash and
whitespace normalisation. No prompt achieves this reliably; scaffolding must never
reach the reader. This is a hard requirement the moment local models are in scope.

The app never calls a provider directly. It calls a **role**: `draft`, `revise`,
`critique`, `summarise`, `extract`, `embed`, `name`. Each role maps to a
`model_profile` with its own model, params and fallback. This matters more than it
sounds:

- Drafting on a strong model while summarising/extracting/critiquing on a cheap
  one cuts running costs by roughly an order of magnitude, because the utility
  roles fire far more often than drafting does.
- Local models slot in per-role — run extraction locally for free and keep
  drafting on OpenRouter, or go fully local.
- `capabilities()` lets the compiler size its budget and decide whether to ask for
  JSON-schema output or fall back to parsing.

**Credentials.** Android → Keystore via a secure-storage plugin. Web → key
encrypted with a passphrase-derived key (WebCrypto, PBKDF2/Argon2) in IndexedDB,
never `localStorage`, never in SQLite, never logged, never in `ai_run.params_json`.
Requests go browser-direct to the provider; OpenRouter supports CORS for this.

## Offline behaviour

Everything except generation works with no network. Generation requests made while
offline enter a queue and fire on reconnect. The Scene Brief is compiled and shown
regardless — you can plan a whole chapter on a plane and let the drafts run later.

## Testing

- **Vitest** for the domain layer, with a fixture novel ("The Grey Warden") used
  across tests: ~40 scenes, 20 entities, 150 facts, deliberate continuity traps.
- **Golden-brief tests**: compiling a brief for a given scene must produce a
  stable, snapshot-compared package. This is the regression net for the core.
- **Recorded-provider tests**: `ai_run` rows from real sessions replay as fixtures,
  so prompt changes can be evaluated without spending money.
- **Playwright** for editor and packaging smoke tests.
