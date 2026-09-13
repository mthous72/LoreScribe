# LoreScribe planning docs

Read in order:

| Doc | What's in it |
|---|---|
| [00 — Vision & Diagnosis](00-vision-and-diagnosis.md) | Why AI novel tools fail, the root cause, and the chosen approach |
| [01 — Architecture](01-architecture.md) | Stack, layers, storage, provider abstraction, credentials, testing |
| [02 — Data Model](02-data-model.md) | The story graph in prose; companion to [`db/schema.sql`](../db/schema.sql) |
| [03 — Story Graph & Scene Brief](03-story-graph-and-context.md) | The core algorithm: temporal facts, spoiler filtering, context compilation, extraction loop |
| [04 — Laws Engine](04-laws-engine.md) | Scoped rules, two-phase enforcement, content floor, IP handling |
| [05 — Planning](05-planning-arcs-and-scenes.md) | Arcs, beats, templates, the planning views |
| [06 — AI Pipeline](06-ai-pipeline.md) | Multi-step generation, modes, cost discipline, local models |
| [07 — Suggestions](07-suggestions-backlog.md) | Everything else worth building, ranked |
| [08 — Roadmap](08-roadmap.md) | Phased plan, product rules, sequencing |
| [09 — LibriScribe review](09-libriscribe-review.md) | What to take from `mthous72/libriscribe`, what to leave, and why this is a new app rather than a refactor |
| [10 — Decision log](10-decisions.md) | D1–D17: the founding choices and why |
| [11 — novelWriter review](11-novelwriter-review.md) | What to take from `saga-soft/novelWriter` — storage robustness and role-typed references |
| [12 — Algorithm specs](12-algorithms.md) | **The implementation reference.** Behaviour specs for the non-obvious algorithms, written to be built from scratch |
| [13 — Legal & compliance](13-legal-and-compliance.md) | Six exposure surfaces and the mechanism for each — routing, structural floor, provenance, dependency licences, real people, data handling |
| [14 — References](14-references.md) | Everything consulted: opened and read (pinned to commits), referred to, or cited from general knowledge and flagged for verification |
| [15 — Phase 0 plan](15-phase-0-plan.md) | **The build starts here.** What has to be *measured* before Phase 0 may end, the four gates, and four defects found in the plan while writing it |
| [16 — Gate A spike report](16-phase-0-spike-report.md) | **The measurements.** The storage bet holds; two of the plan's assumptions did not survive contact with a real browser |

Also: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) (what is derived from
whom, and the notices MIT requires) and
[`tools/third_party_overlap.py`](../tools/third_party_overlap.py) (enforces the
attribution header on derived code and the no-GPL boundary — run it before any
release).

**If you read one thing:** doc 03. It's the product.
**If you read two:** doc 09 — it changes parts of 01, 03, 04, 07 and 08.
**Before building:** doc 10, then **doc 15**, which is the executable form of
Phase 0 — the `opfs-sahpool` spike, what it has to measure, and the gate it has
to clear before anything is built on top of it.
**When building Phase 0b:** doc 12 is the spec; port from LibriScribe with the
attribution header or write fresh, per file ([D11](10-decisions.md)). Never from
novelWriter.
