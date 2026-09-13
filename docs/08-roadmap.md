# Roadmap

Sequenced so that each phase is independently usable and the riskiest assumption
is tested earliest. The riskiest assumption is **"a structured, time-aware graph
produces demonstrably better scenes than a big-context dump."** Phase 2 proves or
kills it. Nothing before Phase 2 should take longer than it has to.

---

## Phase 0 — Foundations *(~1 week)*
- **First, before anything else: the `opfs-sahpool` spike.** Static hosting can't
  set COOP/COEP, so the SharedArrayBuffer OPFS VFS is unavailable and the SAHPool
  VFS is the plan of record ([D8](10-decisions.md)). It gates the entire storage
  layer — confirm it with a real 150k-word database before writing anything on top.
- Vite + React + TS + Tailwind + shadcn/ui; Capacitor initialised but not yet a
  priority.
- `SqlDriver` interface with the sqlite-wasm implementation; Drizzle; the migration
  runner; `db/schema.sql` as migration 001.
- **Multi-tab behaviour in the same spike** — the SAHPool VFS takes exclusive
  access handles, so a second tab must be detected and handled, not left to fail
  with a storage error. `project_lock` plus the Web Locks API, with a real "open in
  another tab" screen and takeover ([doc 11](11-novelwriter-review.md)).
- `navigator.storage.persist()` on first project creation, with the result surfaced
  honestly rather than assumed.
- Repository layer and the `op_log` write path.
- Vitest, Playwright, CI, lint/format, and a dependency-licence allowlist check
  ([doc 13 §4](13-legal-and-compliance.md)).
- **Done when:** a project can be created, persisted and reloaded after a refresh.

## Phase 0b — Implement the specified algorithms *(~1 week, runs alongside Phase 1)*

**Nothing is ported** ([D10](10-decisions.md)). These are written fresh in
TypeScript from the behaviour specifications in [doc 12](12-algorithms.md), which
is the implementation reference — the source repositories are not, and nobody needs
to open them again.

Doing this before the AI work skips months of rediscovery, and five of the eight
need no model at all, which makes Phase 1 more useful standalone.

| Build | Spec | Needs a model? |
|---|---|---|
| Repetition guard (ban list, render, violation check, revision report) | [§1](12-algorithms.md) | no |
| Prose sanitiser, incl. the streaming think-block state machine | [§2](12-algorithms.md) | no |
| Word counter | [§6](12-algorithms.md) | no |
| Readability & pacing statistics | [§7](12-algorithms.md) | no |
| Structural gap finder | [§8](12-algorithms.md) | no |
| Evidence verification | [§3](12-algorithms.md) | at call time |
| Structured-output schema builders + strict detection | [§5](12-algorithms.md) | at call time |
| Reasoning-allowance tracking | [§4](12-algorithms.md) | at call time |

Tests are written **from the specification**, not from anyone's existing test
suite — including the properties the spec calls out explicitly: the sanitiser is
idempotent, the word counter matches hand-verified reference files, the ban list
never contains a proper noun, and staggered fragments merge into one phrase.

## Phase 1 — The graph, with no AI at all *(~3 weeks)*
- Codex CRUD for all entity types, aliases, relationships.
- Manuscript tree (book/part/chapter/scene) with drag reorder and LexoRank.
- Tiptap editor, autosave, word counts, scene versions and diff.
- Alias-matching mention detection; backlinks; entity hover cards; `@` insert.
- Facts UI with `established_at` / `revealed_at` / `fact_knowledge`.
- FTS search across everything.
- **`.libriscribe.json` importer** — entities, chapters, scenes, arcs, milestones,
  threads and prose mapped onto the graph, with chapter integers resolved to scene
  references. LoreScribe is a successor ([D5](10-decisions.md)); nothing else
  matters if your existing books can't come across.
- **Backup and export: automatic, scheduled, and on by default.** Whole-project
  `.lorescribe` archive plus plain Markdown. Not a backlog item — with no server
  and evictable browser storage, this is the only thing between you and total loss
  ([D9](10-decisions.md)). The archive is **versioned and self-describing**: every
  entry carries its own ids, parents, ranks, hash and dates, so a damaged archive is
  partially recoverable and the importer salvages what it can instead of refusing
  the file. A backup you can't open in twelve months isn't a backup.
- **Index rebuild path** for all derived data (`mention`, FTS, embeddings, ranks),
  driven by `index_state` algorithm revisions.
- Word counting as a specified, tested algorithm — not `split(" ")` — used
  identically by goals, stats and budget estimates.
- **Done when:** LoreScribe is already a usable novel-writing app with the best
  lore-linking on the market and zero AI, and your LibriScribe books open in it.
  If this phase isn't pleasant to use, no amount of AI will save it.

## Phase 2 — The Scene Brief Compiler *(~3 weeks)* ← the decisive phase
- `ProviderAdapter` + OpenRouter adapter + secure credential storage.
- Model profiles / roles.
- The compiler, all nine steps, with the **brief inspector UI**.
- Draft, Continue, Expand, Rewrite modes; streaming; cancellation.
- `ai_run` recording with the stored brief.
- Rolling summaries and the continuity ladder.
- Lore Digest compiler for structural generation.
- Reasoning-allowance learning; sanitiser applied to every generated span.
- **Done when:** on the fixture novel, a scene drafted at chapter 30 correctly
  respects facts established in chapter 2 and does not leak a chapter-40 reveal —
  and a big-dump control prompt fails at least one of those. Write that comparison
  down; it is the product thesis.
- **Second control worth running:** the same manuscript through LibriScribe.
  Importing a `.libriscribe.json` bundle is a few hours' work and gives a real
  A/B against a working tool rather than against a strawman prompt.

## Phase 3 — Laws *(~2 weeks)*
- Law CRUD, scoping, presets, the six categories.
- Injection phase; budget protection for `must` laws.
- Verification phase: regex, heuristic, then rubric checks.
- Inline violation UI, targeted auto-revise, amend-the-law flow.
- System hard-floor laws, enforced **structurally** — `entity.maturity` and
  `is_real_person` checked against cast and register before the call
  ([doc 13](13-legal-and-compliance.md)) — plus the provider-refusal reporting path.
- `provider_policy` registry and the register-dial warning that consults it.
- Span-level `origin` marks in the editor, with the provenance rollup.
- IP category: trait-based style rewriting, protected-property warnings.

## Phase 4 — Planning *(~3 weeks)*
- Arcs, beats, `beat_scene`, structure templates.
- Arc board, tension curve, dual timeline, beat/scene matrix.
- Top-down generation (premise → beats → chapters → scene cards).
- Setup/payoff ledger; unrealised-beat and orphan-scene reports.

## Phase 5 — Closing the loop *(~2 weeks)*
- Extraction service, proposal staging, non-destructive field-by-field merge.
- Evidence verification applied across every AI assertion about the manuscript.
- Narrative thread tracker (promises, setups, questions, items).
- Batch continuity checker, including the `knows_too_early` check.
- Pacing dashboard, character presence timeline.
- Character interview mode.
- Reference-material import (PDF/TXT/MD, OCR) as a non-canon source band.

## Phase 6 — Android *(~1 week)*
- Capacitor SQLite driver — the reason Capacitor exists in a project that ships to
  no store: app-private storage is not evictable ([D9](10-decisions.md)).
- Keystore credentials; filesystem for media.
- Responsive/mobile layouts; capture and review flows; offline generation queue.
- TTS read-aloud; dictation.
- Sideloaded debug builds. **No** signing pipeline, store listing or release track
  ([D7](10-decisions.md)).

## Phase 7 — Local models & portability *(~2 weeks)*
- OpenAI-compatible adapter; Ollama/llama.cpp/LM Studio presets.
- LAN endpoint discovery from Android.
- Local embeddings (ONNX/transformers.js) for offline semantic search.
- Export: EPUB, DOCX, Markdown, PDF, `.lorescribe` archive — as **named, saved
  build profiles** (filters, per-level heading format and breaks, what to include:
  body / synopsis / comments / notes), not one-shot menu items.
- Import: Markdown/DOCX/Scrivener.

## The parity bar

LoreScribe replaces LibriScribe ([D5](10-decisions.md)), so there's a bar to clear
before LibriScribe goes to maintenance. Phase in brackets.

**Blocking — LibriScribe does these and they're load-bearing:**

- [ ] Import a `.libriscribe.json` bundle without loss *(1)*
- [ ] Per-item editing of every object, prose included *(1)*
- [ ] Version snapshots with diff and rollback *(1)*
- [ ] Export: project archive, Markdown, plain text *(1)*
- [ ] Write / rewrite **one scene**, propose → diff → accept, spliced in place *(2)*
- [ ] Prompt/context preview before spending a token — the brief inspector *(2)*
- [ ] Live model list per provider; per-project model choice; cost tracking *(2)*
- [ ] Repetition guard and prose sanitiser on every generated span *(0b, 2)*
- [ ] Canon rules that bind generation — the Laws Engine *(3)*
- [ ] Arc milestones, AI-verified against prose with cited evidence *(4)*
- [ ] Narrative thread tracking with an unresolved-threads warning *(5)*
- [ ] Character voice profiles feeding dialogue *(1 data, 2 use)*
- [ ] Brainstorm co-writer with focus that follows the selection *(2)*
- [ ] Proposal review before anything touches live data *(5)*
- [ ] Gap finder *(0b)*
- [ ] Manuscript stats: readability, pacing, ratios *(0b)*

**Non-blocking — LibriScribe has them, LoreScribe can trail:**
semantic/hybrid search *(7)*, reference material + OCR *(5)*, multiple named
brainstorm sessions, partial outline regeneration with chapter locks, batch
cast/world generation, SillyTavern/KoboldAI import *(only if you have such files)*.

**Not being carried across:** the Windows installer, tray and single-instance
launch ([D8](10-decisions.md)); the batch concept→outline→chapters→formatting
pipeline, which is the "write my whole novel" button this project deliberately
doesn't have (see [doc 07 §E](07-suggestions-backlog.md)).

## Later
Series bible, maps, image generation, publishing helpers, plugins. Sync service
only if the single-device assumption ever breaks.

**Total: ~18 weeks at full-time pace** (0b overlaps 1). At evenings-and-weekends
pace, treat Phase 1 as the thing to cut down, not the phases after it.

---

## Product rules that outrank features

These came out of the LibriScribe review and apply to every phase:

1. **No cascade.** Editing anything never regenerates anything downstream. An
   impact view lists every later scene that references the edited entity, and the
   writer decides what to do about it — the tool never does it for them. A writer will
   not trust an AI tool with 80,000 words if editing chapter 3 might silently
   rewrite chapter 30.
2. **Nothing auto-applies.** Every AI output is a proposal until a human accepts it.
3. **Every AI claim about the manuscript cites verified evidence**, or it is
   downgraded to uncertain rather than reported.
4. **Merges never destroy.** Unmentioned fields are preserved, always.
5. **Scaffolding never reaches the reader.** Sanitation is deterministic, not
   prompted.
6. **Telemetry must never break generation.** Cost logging is best-effort and
   wrapped; user data never lives in the install directory. (In LibriScribe a
   logging write to a read-only working directory made *every* completion return an
   empty string — the failure was silent and total.)

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
