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
- `SqlDriver` interface with the sqlite-wasm implementation; Drizzle (carried
  unused through Phase 1 and removed — [D28](10-decisions.md)); the migration
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

## Phase 0b — Implement the specified algorithms *(~1 week, ran alongside Phase 1)* — **model-free half complete**

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

## Phase 1 — The graph, with no AI at all *(~3 weeks)* — **complete**

Everything below is built, tested and merged. The reasoning behind each lives in
the decision it cites and in the file's own header — this list is the plan, not
the changelog.

| Built | Where | The part worth remembering |
|---|---|---|
| Codex: types, aliases, relationships | `data/codexRepository.ts`, `app/CodexPage.tsx` | Attribute fields render from each type's JSON Schema, so migration 002's "a field added here appears in the UI without code" is true |
| Manuscript tree with fractional-key reorder | `data/manuscriptRepository.ts`, `app/ManuscriptPage.tsx` | A reorder writes one row; pointer events with a keyboard path, not HTML5 drag ([D22](10-decisions.md)) |
| Editor, autosave, word counts | `editor/SceneEditor.tsx` | Every path out of the debounce is closed and tested: hidden tab, scene switch, takeover in another tab |
| Scene versions and diff | `text/diff.ts`, `data/versionsRepository.ts`, `app/SceneVersions.tsx` | Paragraph-first diff; a restore keeps the page before overwriting it ([D24](10-decisions.md)) |
| Mentions, backlinks, entity cards, `@` insert | `domain/mentions.ts`, `editor/`, `app/SceneCast.tsx` | Tap, not hover — the phone is a peer ([D15](10-decisions.md)). `@` is the only way to reach a name two entities share |
| Facts, at a reading position | `domain/factVisibility.ts`, `data/factsRepository.ts`, `app/FactsPage.tsx` | The spoiler rule is one pure function, and Phase 2's compiler calls the same one |
| FTS search across scenes and codex | `data/searchQuery.ts`, `searchRepository.ts`, `app/SearchPage.tsx` | Nothing the writer types reaches the FTS5 parser as syntax |
| Bible intake — Markdown, text, Word, JSON, CSV | `import/`, `data/importRepository.ts`, `app/ImportPage.tsx` | Parsers know nothing about story; unrecognised input is listed and skipped; an applied import can be taken back out ([D25](10-decisions.md)) |
| Backup and export | `data/backup.ts`, `archive.ts`, `export/` | The archive is the complete copy and is self-describing so a damaged one is partly recoverable; the Markdown bundle has no private format and reads back through the importer ([D26](10-decisions.md)) |
| Index rebuild path | `index/` | Driven by `index_state` revisions. `embedding` has no rebuilder until a model exists, and says so rather than pretending |
| Word counting as a specified algorithm | `text/words.ts` | Not `split(" ")` — goals, stats and budget estimates all read it |

**Done when — and the honest answer.** The bar was: *already a usable
novel-writing app with the best lore-linking on the market and zero AI, and a
bible you already wrote opens in it. If this phase isn't pleasant to use, no
amount of AI will save it.*

The first two clauses hold. **The third does not.** Every screen was built to
make its own feature provable and none was ever designed against another, which
is a real cost no test can see. That is what [Phase 2.5](#phase-25--making-it-worth-sitting-in-front-of-2-weeks)
is for. The sentence is left standing here rather than quietly softened, because
it is the one this project should be judged against.

## Phase 1b — Beats, the unit of writing *(~1 week)* — **complete**

Named for the 0b precedent: model-free graph work, run to finish what the next
phase needs. It exists because listing "beats will be empty" as an acceptable
Phase 2 degradation was wrong. Doc 03's brief has always had
`beats: BeatTarget[]` — *"what this scene must accomplish"* — and generating
against an empty one is generating against no target, which is precisely the
shapeless output this project exists to beat ([D29](10-decisions.md)).

- `arc`, `beat` and `beat_scene` repository and CRUD. Beat carries `function`
  (setup/inciting/turn/midpoint/crisis/climax/resolution), `tension` and
  `target_chapter_id`; the join carries a role (`setup|develop|payoff|echo`).
- Authoring UI: beats under an arc, and the beats a scene serves shown beside
  the editor next to its cast.
- **The beat/scene matrix** — the `beat_scene` join as a grid, where unrealised
  beats and orphan scenes both jump out ([doc 05](05-planning-arcs-and-scenes.md)).
  It is also the companion to the gap screen in Phase 2, and `findGaps` already
  reports both kinds.
- **Not** in scope, still Phase 4: the arc board, tension curve, dual timeline,
  structure templates, top-down generation.
- **Done when:** a beat can be written, linked to the scenes that carry it, and
  seen unrealised in the matrix — and the fixture novel below can be generated
  with beats planted, because a fixture without them cannot exercise
  beat-driven generation and would measure the wrong thing.
  *(Built — `src/data/planRepository.ts`, `src/app/PlanPage.tsx`,
  `src/app/SceneBeats.tsx`. The grid is the linking surface rather than a
  report: a cell is the `beat_scene` row, so clicking one is the most direct way
  to say a scene carries a beat. `findGaps` finally has a caller — the
  unrealised-beat and orphan-scene markers come from it rather than from a
  second opinion written in the page. The fixture novel is still to come.)*

## Phase 2 — The Scene Brief Compiler *(~3 weeks)* ← the decisive phase
- **Bible intake, second lane.** The deterministic lane moved to Phase 1 and is
  built ([D25](10-decisions.md)); what is left here is the extraction lane, which
  plugs into the same review as a second source of suggestions. Two lanes, run
  over the same document set:
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
- `ProviderAdapter` + OpenRouter adapter + credential storage. The key is sealed
  with a non-extractable device key in IndexedDB and `provider_account` holds only
  a handle ([D30](10-decisions.md)); the row is already excluded from the archive
  export, so the key never travels in a file you hand to someone, and the UI says
  plainly what the device key does and does not protect against. **Done**, less
  the providers screen.
- **The gap screen, and gap-fill as the third proposal lane.** `findGaps` has
  been built and tested since Phase 0b with no caller at all; this is its
  consumer. Each gap gets its own small, focused request rather than one that
  hands a model the whole world — a gap brief, sibling to the scene brief and
  built on the same discipline. Everything lands in `proposal_run` with
  `seed_kind = 'gap_fill'`, a value the schema has carried from the start, and is
  reviewed by the screen the importer already uses ([D29](10-decisions.md)).
- Model profiles / roles.
- The compiler, all nine steps, with the **brief inspector UI**.
- Draft, Continue, Expand, Rewrite — **beat-sized by default**, with whole-scene
  as a coarser mode. A beat's prose is proposed, diffed and spliced in place;
  Phase 3's span-level `origin` marks later record which beat produced which
  span. Streaming; cancellation.
- `ai_run` recording with the stored brief.
- Spend caps ([D17](10-decisions.md)): per-project, per-local-day warning and
  stop in `project.settings_json`; the drafter refuses at the stop before it
  compiles or sends anything and records a `blocked` run; the meter sits under
  the draft controls with the raise one tap away, and the Providers page sets
  both numbers in full. *(Built.)*
- Rolling summaries and the continuity ladder.
- Lore Digest compiler for structural generation.
- Reasoning-allowance learning; sanitiser applied to every generated span.
- **Done when:** on the fixture novel, a scene drafted at chapter 30 correctly
  respects facts established in chapter 2 and does not leak a chapter-40 reveal —
  and a big-dump control prompt fails at least one of those. Write that comparison
  down; it is the product thesis. *(The fixture is built —
  `src/fixture/novel.ts`, generated from a seed and never committed. It returns
  the ids the comparison names rather than leaving a test to hunt for them, and
  `novel.test.ts` proves all five spoiler-rule outcomes fire from the chapter-30
  reading position at once — a fixture that does not discriminate makes a green
  comparison that means nothing.)*
- **Second control:** run the same test against a general-purpose assistant given
  the whole bible in its context window, which is what a writer would otherwise
  do by hand. The LibriScribe A/B this bullet used to describe is gone with the
  importer ([D25](10-decisions.md)), and it was always the weaker comparison —
  a tool nobody else runs is a strawman of a different shape.

## Phase 2.5 — Making it worth sitting in front of *(~2 weeks)*

The only phase whose deliverable is not a capability. Every screen so far was
built to make one feature provable, and none was ever designed against another —
a real cost that no test can see. 491 unit tests and 88 Playwright tests pass
against an app that is still tiring to use for three hours.

Placed after Phase 2, not at the end. Phase 1's done-when already says *"if this
phase isn't pleasant to use, no amount of AI will save it"* — currently the only
sentence in this document with nothing enforcing it. Phase 2 adds the densest UI
in the project (brief inspector, generation controls, streaming, cost), so
polishing before it polishes the wrong screens, and polishing later means Phases
3–5 stack four more surfaces on a layout nobody has drawn.

Kept as 2.5 rather than renumbered: roughly ninety references to phase numbers
exist across the docs and the code, and shifting all of them to insert one phase
is a large edit that buys nothing.

**What is wrong, measured rather than felt** — counts taken at the end of Phase 1:

| | |
|---|---|
| Files in `src/ui/` | 1, and it is a drag hook |
| Copies of one button class string | 15 — so a change to how a primary action looks will not happen |
| `text-xs opacity-NN` spans | 53, across 7 opacity values chosen per component |
| Pages at `max-w-3xl` | 11, whether they hold a tree, a table or a paragraph |
| Colours meaning warning / destructive / positive | 19, by a convention written down nowhere |
| Ways to navigate inside a project | none — inline underlined text in the page body, back via `← Manuscript` |

`index.css` sets a considered 34rem measure and 1.7 line-height for prose and
nothing at all for the chrome around it. Diagnostics — a developer surface —
sits at equal billing with the writer's work in the only header there is. The
facts and import screens are correct and look like admin panels, because that is
what they were built as.

**Scope:**

- A small component layer in `src/ui/`: button, field, row, panel, empty state,
  dialog. Not a design system — the set that removes the copy-paste.
- One declared type scale and one declared set of semantic colours, in
  `index.css` beside the prose rules, replacing the per-component guesswork.
- Real navigation: a project-scoped header, every screen one step from every
  other, Diagnostics out of the writer's primary nav.
- Empty states that say what a screen is for and what to do first.
- A layout pass per screen — facts and import especially, and the manuscript
  tree, which is the one a writer looks at most.
- **The phone judged as a writing surface, not a working one.** [D15](10-decisions.md)
  makes it a peer; the Phase 1 device pass only established that things
  *function*. Writing on it for twenty minutes has never been tried.
- Accessibility finished rather than started: visible focus, AA contrast, and the
  keyboard paths that exist joined into something you can drive without a pointer.

**Not in scope**, still cut by [D7](10-decisions.md) and explained by
[D27](10-decisions.md): onboarding funnels, first-run tutorials, marketing
surfaces, a theming system, animation, a component-library dependency.

**Done when** — three checks, because "it feels better" is not a bar:

1. **Mechanical.** No copy-pasted button strings; every size and weight from the
   declared scale; every screen one step away; nothing below AA contrast; suite
   still green.
2. **A session.** Draft a scene of at least 500 words **on the phone**, start to
   finish, without opening a second app. Write down what got in the way — that
   record is the artifact, the way Phase 2's control comparison is.
3. **Honest.** Re-read Phase 1's done-when and answer in writing, with reasons,
   whether it is true yet. If it is not, this phase is not finished.

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

## Phase 4 — Planning *(~2 weeks)*
- Structure templates. *(Arcs, beats and `beat_scene` moved to Phase 1b, and the
  beat/scene matrix with them — [D29](10-decisions.md).)*
- Arc board, tension curve, dual timeline.
- Top-down generation (premise → beats → chapters → scene cards).
- Setup/payoff ledger; unrealised-beat and orphan-scene reports.

## Phase 5 — Closing the loop *(~2 weeks)*
- Extraction service, proposal staging, non-destructive field-by-field merge — the
  general form of the bible-intake pipeline built in Phase 1, now triggered
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

LoreScribe succeeds LibriScribe ([D5](10-decisions.md)). The bar was originally
"what must work before LibriScribe goes to maintenance" — [D25](10-decisions.md)
removed that framing, since LibriScribe has no users left to protect and its
importer was dropped for the same reason.

What the list is still worth keeping for: LibriScribe was used to write with, so
each line below is a thing that turned out to matter in practice rather than a
feature somebody imagined. It is a checklist of earned requirements, not a debt.
Phase in brackets.

**Load-bearing — these were used, and their absence would be felt:**

- [x] ~~Import a `.libriscribe.json` bundle without loss~~ — dropped,
      [D25](10-decisions.md): it protected nobody. Bible intake replaces it *(1)*
- [ ] Per-item editing of every object, prose included *(1)* — manuscript,
      codex, facts and prose yes; arcs, beats and notes have no editor yet
- [x] Version snapshots with diff and rollback *(1)*
- [x] Export: project archive, Markdown, plain text *(1)*
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

**Total: ~21 weeks at full-time pace** (0b overlapped 1; Phase 2.5 added two;
Phase 1b added one and took one back off Phase 4).
At evenings-and-weekends pace, treat Phase 1 as the thing to cut down, not the
phases after it — advice now spent, since Phase 1 is done.

**Where it actually stands:** Phases 0, 0b (model-free half) and 1 are complete.
Phase 2 is next and is the one that proves or kills the premise.

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

## Spikes still outstanding — now Phase 2 entry work

Phase 1 has ended, so these are no longer "before it ends". Both remaining ones
gate Phase 2's first week and neither has been run.

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
