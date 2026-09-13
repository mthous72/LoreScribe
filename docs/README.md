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
| [10 — Decision log](10-decisions.md) | D1–D9: the founding choices and why |
| [11 — novelWriter review](11-novelwriter-review.md) | What to take from `saga-soft/novelWriter` — storage robustness, role-typed references, and a licensing constraint |

**If you read one thing:** doc 03. It's the product.
**If you read two:** doc 09 — it changes parts of 01, 03, 04, 07 and 08.
**Before building:** doc 10, then the `opfs-sahpool` spike at the top of Phase 0.
