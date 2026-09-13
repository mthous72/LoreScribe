# LoreScribe — Vision & Diagnosis

## Why this document exists

Plenty of AI writing tools exist. Most of them fail at novel length in the same
predictable ways. Before designing features, this document names *why* they fail,
so the architecture targets the cause rather than the symptoms.

---

## Step 1 — Candidate root causes

Six failure modes, each pushed two levels deeper than the surface complaint.

### C1. Context window is treated as story memory
- *Surface:* "The AI forgot that Maren is dead."
- *Why?* The tool packs the prompt with the most **recent** text until it fills.
- *Why does that fail?* Recency is a poor proxy for relevance. A 120k-word novel
  never fits, so at chapter 30 everything from chapters 1–25 is simply gone.
  There is no mechanism that asks "what does *this* scene need to know?"

### C2. Lore is stored as prose blobs
- *Surface:* Character sheets are big free-text fields.
- *Why?* Free text is trivial to build and feels flexible to the writer.
- *Why does that fail?* Prose is not queryable. You cannot diff it, cannot detect
  that two entries contradict, cannot compute "what is true as of chapter 14,"
  and cannot assemble a minimal prompt. You are forced to choose between dumping
  the whole wiki (blows the budget, buries the signal) or dumping nothing.

### C3. No model of time or knowledge state
- *Surface:* The AI spoils a twist, or writes a character acting on information
  they haven't learned yet.
- *Why?* Facts are stored as timeless properties. "Kaelen is the traitor" is just
  true, always.
- *Why does that fail?* A novel is a controlled information release. Every fact
  has (at least) two distinct timestamps — when it became true in the world, and
  when the reader learns it — plus a per-character map of who knows it. Without
  those axes the tool cannot write chapter 5 and chapter 25 differently.

### C4. Plan and prose are separate documents that drift
- *Surface:* The outline stops matching the manuscript by act two.
- *Why?* The outline is a doc, the manuscript is another doc, and nothing links a
  beat to the text that realizes it.
- *Why does that fail?* No query can answer "which beats are still unwritten,"
  "which scenes no longer serve their arc," or "this setup was never paid off."
  The plan degrades into a stale artifact the writer stops opening.

### C5. "Rules for the AI" are advisory prose with no verification
- *Surface:* "I told it three times not to use adverbs in dialogue tags."
- *Why?* Rules get concatenated into a long system prompt and hoped for.
- *Why does that fail?* Instructions buried mid-prompt are reliably dropped, and
  nothing ever *checks* the output. A rule with no verification step and no
  scoping is a wish, not a constraint.

### C6. Single-provider coupling
- *Surface:* Local model support is "coming soon" forever.
- *Why?* The app is built around one vendor's request/response shape.
- *Why does that fail?* Local models differ in context size, tool-use support,
  JSON-mode reliability and tokenizer. Assumptions baked in at the call site
  (rather than behind a capability-aware adapter) have to be unpicked everywhere.

### C7. Generation is monolithic
- *Surface:* "Write chapter 12" produces 3000 words of mush.
- *Why?* One prompt, one call, one shot.
- *Why does that fail?* Quality decays with output length, the writer cannot steer
  mid-flight, and there is no artifact to critique against. Also nothing feeds
  the accepted prose *back* into the lore, so the codex rots while the book grows.

---

## Step 2 — The selected root cause

> **C1 + C2 + C3 are one cause wearing three hats: there is no queryable,
> time-aware knowledge graph, and therefore no way to assemble a minimal,
> correct, spoiler-safe context for exactly one scene.**

Everything else is downstream of this:

- C4 (drift) is the same missing linkage applied to plan artifacts instead of lore.
- C5 (rules ignored) is unenforceable partly because canon rules can't be derived
  from anything machine-readable.
- C7 (mush) is unfixable while each call is starved of precise context.

**Why this diagnosis and not another.** The competing explanation is "the models
just aren't good enough yet." That's testable and it's wrong: the same model that
contradicts itself at chapter 30 handles the contradiction perfectly when the
relevant three facts are placed in front of it. The bottleneck is retrieval and
representation, not reasoning. Bigger context windows don't fix it either — they
raise cost linearly while *lowering* instruction adherence, and they still can't
answer "does the POV character know this yet?"

So the load-bearing component of LoreScribe is not the editor and not the prompt
library. It is the **Story Graph** and the **Scene Brief Compiler** that reads it.
Build those first; every other feature either feeds the graph or consumes it.

---

## Step 3 — Solution paths considered

### Path A — Pure RAG over the manuscript and lore notes
Chunk everything, embed it, retrieve top-k per generation.
- **Pros:** fast to build, provider-agnostic, no schema design.
- **Cons:** non-deterministic (the one fact that matters is often rank 11);
  cannot express "true since chapter 2, revealed chapter 20"; cannot guarantee
  spoiler safety; retrieval quality collapses on pronouns and aliases. This is
  what most tools do, and it's why they behave the way they do.

### Path B — Structured knowledge graph with temporal facts, graph-first assembly
Entities, typed relationships, and atomic facts carrying `established_at`,
`revealed_at` and per-character knowledge. Context is assembled by deterministic
traversal from the scene's linked cast/location/beats, with vector search used
only as a **supplement** for "anything relevant I forgot to link."
- **Pros:** deterministic and auditable (the writer can see exactly what the AI
  will see); spoiler safety is a query filter, not a prayer; contradiction
  detection, setup/payoff ledgers and "who knows what" all fall out of the same
  structure; degrades gracefully into small local-model context budgets.
- **Cons:** real schema work up front; risk of turning into data-entry homework.

### Path C — Agentic tool-use — let the model query the codex itself
Expose lore as tools and let the model decide what to fetch.
- **Pros:** elegant, minimal prompt assembly.
- **Cons:** multiplies latency and cost per scene, fails entirely on local models
  without reliable tool-calling, and non-determinism moves from retrieval into
  the agent loop. Viable later as an *optional* mode on capable models.

### Chosen: **Path B**, with C as a later opt-in mode and A embedded inside B.

The one real objection to B — data-entry homework — is answered by the
**extraction loop**: after prose is accepted, a cheap model proposes new entities,
facts and mentions from that prose, and the writer confirms with one click. The
graph is then mostly *harvested* from writing rather than typed in advance.

---

## What LoreScribe is, in one paragraph

A local-first novel workspace whose source of truth is a temporal story graph:
structured lore, world, characters, arcs and beats, each linked to the exact
scenes they belong to. Every AI action compiles a **Scene Brief** — a visible,
budgeted, spoiler-filtered context package — and every AI output is checked
against user-defined **Laws** before it is accepted. Provider-agnostic from day
one (OpenRouter first, local models next), with the writer's own API key and
their manuscript never leaving their device unless they choose otherwise.
