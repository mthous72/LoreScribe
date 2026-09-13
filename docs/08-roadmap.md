# Roadmap

Sequenced so that each phase is independently usable and the riskiest assumption
is tested earliest. The riskiest assumption is **"a structured, time-aware graph
produces demonstrably better scenes than a big-context dump."** Phase 2 proves or
kills it. Nothing before Phase 2 should take longer than it has to.

---

## Phase 0 — Foundations *(~1 week)* — **complete**

**[Doc 15](15-phase-0-plan.md) is the executable version of this phase** and
**[doc 16](16-phase-0-spike-report.md) holds the measurements.** Every gate is
green, including the one that needed a real phone: `opfs-sahpool`'s exclusive
handles survived a backgrounded tab on Android, so the web path holds on the
primary platform and Capacitor stays in Phase 6. What follows is the summary of
what the phase contained.

- **First, before anything else: the `opfs-sahpool` spike.** Static hosting can't
  set COOP/COEP, so the SharedArrayBuffer OPFS VFS is unavailable and the SAHPool
  VFS is the plan of record ([D8](10-decisions.md)). It gates the entire storage
  layer — confirm it with a real 150k-word database before writing anything on top.
  The corpus is **generated from a seed at run time, never committed**
  ([D14](10-decisions.md)).
- Vite + React + TS + Tailwind + shadcn/ui. **Capacitor is not initialised in this
  phase** — with no native SQLite driver until Phase 6, a native build would boot
  to an error, so "on a real Android phone" below means the PWA in Chrome on the
  device, which is the evictable web path rather than the app-private native one.
  The only thing Phase 0 owes Phase 6 is a build base path that is a switch rather
  than a constant ([doc 15 §3d](15-phase-0-plan.md)).
- `SqlDriver` interface with the sqlite-wasm implementation; Drizzle; the migration
  runner; `db/schema.sql` as migration 001 — **minus its pragmas**, which are
  per-connection settings that differ by engine and belong in the driver
  ([doc 15 §3a](15-phase-0-plan.md)). A **driver conformance suite** is written
  here, against the interface rather than the implementation, so Phase 6 is
  "make the Capacitor driver pass it" and not an excavation.
- **Multi-tab behaviour in the same spike** — the SAHPool VFS takes exclusive
  access handles, so a second tab must be detected and handled, not left to fail
  with a storage error. `project_lock` plus the Web Locks API, with a real "open in
  another tab" screen and takeover ([doc 11](11-novelwriter-review.md)). The lease
  semantics behind `project_lock`'s heartbeat get specified here rather than
  inherited from whatever the first implementation happened to do.
- **Backgrounding on Android**, in the same spike: Chrome backgrounds tabs
  aggressively and the VFS holds exclusive sync access handles. If those don't
  survive a call or an app switch, the web path on the primary platform is
  unusable and Capacitor moves forward into this phase.
- `navigator.storage.persist()` on first project creation, with the result surfaced
  honestly rather than assumed.
- Repository layer (`project` only) and the `op_log` write path.
- Vitest, Playwright, CI, lint/format, and a dependency-licence allowlist check
  ([doc 13 §4](13-legal-and-compliance.md)).
- CI deploy to GitHub Pages (confirmed: the repo is public, so this needs no
  account upgrade — the served app is a public URL, holding no data until someone
  creates a project on that device; see [D14](10-decisions.md) for the boundary
  this does *not* cross).
- **Done when:** `docs/16-phase-0-spike-report.md` is committed with measured
  numbers from three environments — local Chrome, the Pages origin on desktop,
  and the Pages origin on the phone — and every threshold in
  [doc 15 §4](15-phase-0-plan.md) is met or explicitly waived with a reason. A
  project that can be created and reloaded is the *floor*, not the bar: it is true
  of a three-row database with no lock and no size, and it would let every risk
  this phase exists to find survive into Phase 1.

## Phase 0b — Implement the specified algorithms *(~1 week, runs alongside Phase 1)*

[Doc 12](12-algorithms.md) is the specification and the tests are written against
it. Per file, either **port from LibriScribe with the attribution header**
([D11](10-decisions.md)) or write fresh — whichever is faster for that file. Nothing
is taken from novelWriter (GPL-3) under any circumstances. Run
`tools/third_party_overlap.py` before merging.

Doing this before the AI work skips months of rediscovery, and five of the eight
need no model at all, which makes Phase 1 more useful standalone.

| Build | Spec | Needs a model? | State |
|---|---|---|---|
| Repetition guard (ban list, render, violation check, revision report) | [§1](12-algorithms.md) | no | **done** |
| Prose sanitiser, incl. the streaming think-block state machine | [§2](12-algorithms.md) | no | **done** |
| Word counter | [§6](12-algorithms.md) | no | **done** |
| Readability & pacing statistics | [§7](12-algorithms.md) | no | **done** |
| Structural gap finder | [§8](12-algorithms.md) | no | **done** |
| Evidence verification | [§3](12-algorithms.md) | at call time | Phase 2 |
| Structured-output schema builders + strict detection | [§5](12-algorithms.md) | at call time | Phase 2 |
| Reasoning-allowance tracking | [§4](12-algorithms.md) | at call time | Phase 2 |

All five model-free algorithms are written fresh against the spec rather than
ported — the overlap tool reports no derived lines — with a shared
`difflib.SequenceMatcher` ratio underneath the two that need it, pinned to
CPython's numbers because both thresholds were calibrated against them.

Tests are written **from the specification** — including the properties the spec
calls out explicitly: the sanitiser is
idempotent, the word counter matches hand-verified counts, the ban list never
contains a proper noun, and staggered fragments merge into one phrase. (The
counter's cases are inline in the test rather than in fixture files, so the
arithmetic sits beside the expectation where a reviewer can check it.)

## Phase 1 — The graph, with no AI at all *(~3 weeks)*
- Codex CRUD for all entity types, aliases, relationships.
- Manuscript tree (book/part/chapter/scene) with drag reorder and LexoRank.
  *(Built — `src/data/manuscriptRepository.ts` and `src/app/ManuscriptPage.tsx`.
  A reorder writes one row; `global_rank` and `scene_fts` move in the same
  transaction. Pointer events with a keyboard path, not HTML5 drag-and-drop,
  which never fires on touch — [D22](10-decisions.md).)*
- Tiptap editor, autosave, word counts, scene versions and diff.
  *(Editor, autosave and word counts built — `src/editor/SceneEditor.tsx`.
  Scene versions and diff are not. Every path out of the autosave debounce is
  closed and tested: hidden tab, scene switch, and a takeover in another tab,
  which now waits for the save rather than racing it.)*
- Alias-matching mention detection; backlinks; entity hover cards; `@` insert.
  *(Detection and live highlighting run against real prose in the editor.
  Backlinks, hover cards and `@` insert are not built, and there is no codex UI
  yet to create the entities they would link to.)*
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
  driven by `index_state` algorithm revisions. *(Built — `src/index/`, surfaced
  as a settings panel. `embedding` has no rebuilder until Phase 3 brings a
  model, and says so rather than pretending.)*
- Word counting as a specified, tested algorithm — not `split(" ")` — used
  identically by goals, stats and budget estimates.
- **Done when:** LoreScribe is already a usable novel-writing app with the best
  lore-linking on the market and zero AI, and your LibriScribe books open in it.
  If this phase isn't pleasant to use, no amount of AI will save it.

## Phase 2 — The Scene Brief Compiler *(~3 weeks)* ← the decisive phase
- **Bible intake, first.** A real project (a story bible that predates LoreScribe
  entirely, never run through LibriScribe) needs a way in before any brief can be
  compiled against it. Two lanes, run over the same document set:
  - **Template-aware structured parsing**, no model call: sections that already
    follow a recognisable shape — a character file's Bio/Want/Need/Past/Arc
    fields, a "who knows what" table, a physical-state note scoped to a scene —
    map mechanically onto `entity`, `arc` and `fact`/`fact_knowledge` rows. This
    is the cheap, deterministic path, and it exists because real bibles are often
    already this well organised — worth checking for the shape before reaching
    for a model.
  - **Extraction for the rest** — freeform prose (a full-story summary, a loose
    outline) goes through the same proposal-staging pipeline
    [doc 05](05-planning-arcs-and-scenes.md) and [doc 03](03-story-graph-and-context.md)
    describe for Phase 5, pulled forward here because Phase 2's brief compiler
    needs a populated graph to compile anything against. Phase 5 later
    generalises this into the automatic post-scene pass; this is its first,
    manually-triggered use.
  - Everything lands as proposals, reviewed once, same as any other extraction —
    D14 applies: the bible itself never enters this public repository.
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
- **Second control, where it applies:** for a manuscript that already has a
  LibriScribe project, importing its `.libriscribe.json` bundle and running the
  same test there is a real A/B against a working tool rather than a strawman
  prompt. Not every fixture will have one — the bible-intake path above exists
  precisely for the case where it doesn't.

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
- Extraction service, proposal staging, non-destructive field-by-field merge — the
  general form of the bible-intake pipeline built in Phase 2, now triggered
  automatically after each scene rather than manually against a whole document.
- Evidence verification applied across every AI assertion about the manuscript.
- Narrative thread tracker (promises, setups, questions, items).
- Batch continuity checker, including the `knows_too_early` check.
- Pacing dashboard, character presence timeline.
- Character interview mode.
- Reference-material import (PDF/TXT/MD, OCR) as a non-canon source band.

## Phase 6 — Android *(~1 week)*
- Target: a recent Android phone, last ~3 years (Android 12/API 31+) — the
  primary platform, not a secondary one ([D13](10-decisions.md)).
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

   **Carve-out: the sync log is not telemetry.** `op_log` is written in the same
   transaction as the mutation it describes, and a failure to write it rolls the
   mutation back. That looks like a violation of this rule and is deliberately
   not one, because the two records fail in opposite directions.

   The test is whether the record can be reconstructed afterwards. A cost figure
   can: the `ai_run` row still holds the tokens, and a missing total is a gap in
   a report. `op_log` cannot — nothing anywhere else says *what changed*, so a
   dropped entry leaves a log that silently disagrees with the data it claims to
   describe, and every consumer of it from that point on is working from a
   fiction. A best-effort sync log is worse than no sync log, because it looks
   trustworthy.

   So: **anything written for our benefit is best-effort and wrapped; anything
   that is part of the user's record is atomic with it.** `op_log`, `rev` and
   soft-delete tombstones are the second kind. Cost logging, spend meters,
   `ai_run` timings and the diagnostics harness are the first, and none of them
   may ever take a write down with them.

   The accepted consequence, stated rather than discovered later: if the database
   cannot accept an `op_log` row, the user's edit fails too. Under the conditions
   that cause it — a full disk, a corrupt file — the edit was not going to
   succeed anyway, so the honest failure is the loud one.

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

The first of these moved into Phase 0 proper and is specified in
[doc 15 §4](15-phase-0-plan.md) — SQLite-WASM + OPFS at 150k words, with query
latency, editor jank and quota behaviour as recorded numbers rather than
impressions. Safari/iOS is deliberately **not** in it: [D13](10-decisions.md)
scopes the target to Chromium, and if that ever changes it reopens D13 and
possibly [D8](10-decisions.md) rather than being absorbed as a bug. The rest
still stand:

- ~~Tiptap with a 5000-word scene plus live mention decorations~~ — **done.**
  5,037 words, 51 paragraphs, 200 aliases, 137 highlighted spans. Cold start
  69 ms; per-keystroke p50 0.8 ms, p95 1.7 ms; worst main-thread frame gap
  36 ms. Rescanning the whole document on every keystroke instead costs p50
  3.9 ms — **4.9× the incremental path**, measured through identical
  transactions and paints rather than by timing a regex against a render.
  Both stay inside a frame on desktop; the headroom is what buys the phone,
  which is the platform the spike existed for. Re-runnable from
  `/#/diagnostics` on any device.
- OpenRouter streaming direct from a browser: CORS, cancellation, error shapes.
- A token counter that's accurate enough across model families to budget with.
