# Architecture

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Code sharing | **React + TypeScript + Vite, wrapped by Capacitor** | One UI, one data layer, ships as an installable PWA (built — manifest, icons and a precaching service worker, [D21](10-decisions.md)) and a sideloaded Android APK ([D7](10-decisions.md)). Keeps us in the JS/TS ecosystem where the editor (ProseMirror) and AI SDKs live. |
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
│ Data          Repositories → SqlDriver → SQLite          │
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
on Android both speak SQLite, so the repositories sit over a thin `SqlDriver`
interface with two implementations. They write SQL directly; there is no ORM
([D28](10-decisions.md) — one was carried unused through Phase 1 and removed).
The driver's shape — the method names `run` / `all` / `get` / `values`, and rows
returned as **positional arrays** — is inherited from the `sqlite-proxy` contract
it was originally built against, and kept because every repository reads rows
that way and an async callback maps cleanly onto worker `postMessage`.
Migrations are plain numbered `.sql` files, inlined at build time and applied in
a transaction at startup. Consequences worth knowing up front:

- Run SQLite in a **dedicated** web worker — not merely to keep long queries off
  the main thread, but because `createSyncAccessHandle()` exists nowhere else.
- Large prose blobs are fine in SQLite; media (portraits, maps) go to OPFS /
  Capacitor Filesystem with only a URI in the row.
- **The worker RPC layer is ours.** `sqlite3Worker1Promiser` was deprecated in
  April 2026 and its author calls it "too fragile, too imperformant, and too
  limited for any non-toy software."
- **Migration application is ours.** No off-the-shelf migrator survives here —
  the one this project originally planned to use reads files off disk at run
  time, which a browser cannot do. `PRAGMA user_version` is the source of truth
  and a `schema_migration` audit log sits beside it, deliberately not
  load-bearing. A change to `db/schema.sql` needs a matching migration, always
  ([D23](10-decisions.md)).
- **Pragmas live in the driver, never in the schema** — they are per-connection,
  order-sensitive, and the two engines land in different journal modes (Android
  is WAL2 by default; sahpool needs `locking_mode=exclusive` first and gains
  little). The driver sets them per engine and **reads the mode back** rather
  than assuming, because `journal_mode` reports its result instead of failing.
- **`reserveMinimumCapacity()` at startup, and `temp_store=MEMORY`.** The sahpool
  capacity is a *file count* defaulting to 6; overflow surfaces as a misleading
  `SQLITE_CANTOPEN`, and temp files consume slots.

The details behind each of these, with sources, are in
[doc 15 §7](15-phase-0-plan.md).

### Hosting and the cross-origin-isolation trap

The app is served as a static PWA on **GitHub Pages** (decided, not merely
convenient — the repository is public, so this needs no account upgrade). The
served page is just code; no project data reaches it until someone creates a
project on that device, which is the boundary [D14](10-decisions.md) draws
around what a public repo is allowed to hold. Static hosts **cannot set response
headers**, and the SharedArrayBuffer-based OPFS VFS requires cross-origin isolation
(`COOP: same-origin`, `COEP: require-corp`) because it uses `Atomics.wait` in a
worker. So that VFS is unavailable.

The intended path is the **`opfs-sahpool` VFS**, which uses a pre-opened pool of
sync access handles and needs no cross-origin isolation. **Confirmed against
sqlite.org's own documentation** ([doc 15 §7](15-phase-0-plan.md)): it explicitly
"does not require COOP/COEP HTTP headers," and the selection guidance routes
clients that can't set those headers to precisely this VFS.

So the hosting choice doesn't merely permit sahpool, it *forces* it — and that
propagates further than it first appears. sahpool pre-opens and holds every
handle in its pool, so it is **single-connection by construction** and offers no
concurrency. That in turn forces a deliberate multi-tab strategy (a Web Lock, a
`pauseVfs()`/`unpauseVfs()` handoff, and a takeover screen that offers *reload*
rather than retry, because the failed install is cached), and it removes WAL's
reason to exist on the web. One hosting decision, three design consequences.

What Phase 0's spike still has to establish is scale and behaviour under
backgrounding, not viability. Fallbacks, in order: a service-worker COI shim,
which buys the plain `opfs` VFS and real concurrency; then revisiting
the no-desktop-wrapper decision — though note that reversal is dearer than it
looked, since Tauri v2 has mobile targets but no confirmable PWA story.

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
Reasoning models emit hidden deliberation tokens ahead of the visible answer —
roughly 2,500 of them for a two-sentence request, in one measured case. A budget sized for the
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
This is deliberately the *only* thing encrypted at rest — the project database
itself is not ([D12](10-decisions.md)); a credential and a manuscript are
different risk classes, and the device's own security covers the second.
Requests go browser-direct to the provider; OpenRouter supports CORS for this.

## Offline behaviour

Everything except generation works with no network. Generation requests made while
offline enter a queue and fire on reconnect. The Scene Brief is compiled and shown
regardless — you can plan a whole chapter on a plane and let the drafts run later.

## Testing

- **Vitest** for the domain layer, with a synthetic fixture novel ("The Grey
  Warden") used across automated tests: ~40 scenes, 20 entities, 150 facts,
  deliberate continuity traps. Invented, so it lives in the repo with no privacy
  concern ([D14](10-decisions.md)).
- **The Phase 2 decisive test** (doc 08) runs against a real manuscript instead,
  precisely because a synthetic fixture is only as good as the traps someone
  thought to plant. That manuscript is never committed to this repository — see
  [D14](10-decisions.md) — and is read by the test harness from a local path or
  environment variable kept outside version control.
- **Golden-brief tests**: compiling a brief for a given scene must produce a
  stable, snapshot-compared package. This is the regression net for the core.
- **Recorded-provider tests**: `ai_run` rows from real sessions replay as fixtures,
  so prompt changes can be evaluated without spending money.
- **Playwright** for editor and packaging smoke tests.
