# Roadmap

Sequenced so that each phase is independently usable and the riskiest assumption
is tested earliest. The riskiest assumption is **"a structured, time-aware graph
produces demonstrably better scenes than a big-context dump."** Phase 2 proves or
kills it. Nothing before Phase 2 should take longer than it has to.

---

## Phase 0 — Foundations *(~1 week)*
- Vite + React + TS + Tailwind + shadcn/ui; Capacitor initialised but not yet a
  priority.
- `SqlDriver` interface with the sqlite-wasm/OPFS implementation; Drizzle; the
  migration runner; `db/schema.sql` as migration 001.
- Repository layer and the `op_log` write path.
- Vitest, Playwright, CI, lint/format.
- **Done when:** a project can be created, persisted and reloaded after a refresh.

## Phase 1 — The graph, with no AI at all *(~3 weeks)*
- Codex CRUD for all entity types, aliases, relationships.
- Manuscript tree (book/part/chapter/scene) with drag reorder and LexoRank.
- Tiptap editor, autosave, word counts, scene versions and diff.
- Alias-matching mention detection; backlinks; entity hover cards; `@` insert.
- Facts UI with `established_at` / `revealed_at` / `fact_knowledge`.
- FTS search across everything.
- **Done when:** LoreScribe is already a usable novel-writing app with the best
  lore-linking on the market and zero AI. If this phase isn't pleasant to use,
  no amount of AI will save it.

## Phase 2 — The Scene Brief Compiler *(~3 weeks)* ← the decisive phase
- `ProviderAdapter` + OpenRouter adapter + secure credential storage.
- Model profiles / roles.
- The compiler, all nine steps, with the **brief inspector UI**.
- Draft, Continue, Expand, Rewrite modes; streaming; cancellation.
- `ai_run` recording with the stored brief.
- Rolling summaries and the continuity ladder.
- **Done when:** on the fixture novel, a scene drafted at chapter 30 correctly
  respects facts established in chapter 2 and does not leak a chapter-40 reveal —
  and a big-dump control prompt fails at least one of those. Write that comparison
  down; it is the product thesis.

## Phase 3 — Laws *(~2 weeks)*
- Law CRUD, scoping, presets, the six categories.
- Injection phase; budget protection for `must` laws.
- Verification phase: regex, heuristic, then rubric checks.
- Inline violation UI, targeted auto-revise, amend-the-law flow.
- System hard-floor laws and the provider-refusal reporting path.
- IP category: trait-based style rewriting, protected-property warnings.

## Phase 4 — Planning *(~3 weeks)*
- Arcs, beats, `beat_scene`, structure templates.
- Arc board, tension curve, dual timeline, beat/scene matrix.
- Top-down generation (premise → beats → chapters → scene cards).
- Setup/payoff ledger; unrealised-beat and orphan-scene reports.

## Phase 5 — Closing the loop *(~2 weeks)*
- Extraction service and the review queue.
- Batch continuity checker.
- Repetition/echo detector, pacing dashboard, character presence timeline.
- Character interview mode.

## Phase 6 — Android *(~2 weeks)*
- Capacitor SQLite driver; Keystore credentials; filesystem for media.
- Responsive/mobile layouts; capture and review flows; offline generation queue.
- TTS read-aloud; dictation.
- Play Store build pipeline, signing, release track.

## Phase 7 — Local models & portability *(~2 weeks)*
- OpenAI-compatible adapter; Ollama/llama.cpp/LM Studio presets.
- LAN endpoint discovery from Android.
- Local embeddings (ONNX/transformers.js) for offline semantic search.
- Export: EPUB, DOCX, Markdown, PDF, `.lorescribe` archive.
- Import: Markdown/DOCX/Scrivener.

## Later
Sync service, series bible, maps, beta-reader mode, collaboration, publishing
helpers, plugins.

---

## Sequencing rules

1. **Phase 1 before any AI.** The graph is the product; AI is a consumer of it.
   Building generation first would let a weak data model hide behind good prose.
2. **The brief inspector ships with the first generation feature, not later.**
   It's the debugging surface for everything after it.
3. **Android after the data model settles.** Capacitor packaging is a week; a
   schema migration across two storage engines with real user data is not.
4. **Local models last among the AI work, designed for from the start.** The
   budget allocator and capability model are what make it a config change; if
   Phase 2 is built right, Phase 7 is small.

## Early technical spikes worth doing before Phase 1 ends

- SQLite-WASM + OPFS with a 150k-word project: query latency, editor jank,
  storage quota behaviour, and what happens on a Safari/iOS browser.
- Tiptap with a 5000-word scene plus live mention decorations: measure, don't hope.
- OpenRouter streaming direct from a browser: CORS, cancellation, error shapes.
- A token counter that's accurate enough across model families to budget with.
