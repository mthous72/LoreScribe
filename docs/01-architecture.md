# Architecture

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Code sharing | **React + TypeScript + Vite, wrapped by Capacitor** | One UI, one data layer, ships as an installable PWA and a real Play Store APK. Keeps us in the JS/TS ecosystem where the editor (ProseMirror) and AI SDKs live. |
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

- OPFS requires cross-origin isolation headers (`COOP`/`COEP`) on the web build.
- Web workers: run SQLite in a worker so long queries don't jank the editor.
- Large prose blobs are fine in SQLite; media (portraits, maps) go to OPFS /
  Capacitor Filesystem with only a URI in the row.

## Provider abstraction

```ts
interface ProviderAdapter {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  capabilities(modelId: string): ModelCapabilities;  // ctx window, tools,
                                                     // json schema, vision, cost
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>;
  embed?(texts: string[]): Promise<Float32Array[]>;
  countTokens(text: string, modelId: string): number;
}
```

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
