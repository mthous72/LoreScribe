# The Story Graph & the Scene Brief Compiler

This is the core of LoreScribe. Everything else is an interface onto it.

## The problem restated

To write scene S well, a model needs a small, correct, spoiler-safe package of
context. "Small" because budget and instruction-adherence both degrade with
length. "Correct" because one stale fact produces a continuity error the writer
must hunt down later. "Spoiler-safe" because the model must not know things the
narrative hasn't earned yet.

Recency-based context gets all three wrong. Vector search gets "small" right and
the other two wrong.

## The Scene Brief

A **Scene Brief** is a typed, budgeted, inspectable object compiled fresh for
every AI action. It is stored verbatim on every `ai_run`, and it is rendered in
the UI *before* you press generate — the writer can see precisely what the model
will see, and edit it.

```ts
interface SceneBrief {
  scene:      { id; title; purpose; povEntity; povMode; tense; location;
                storyTime; targetWords };
  beats:      BeatTarget[];        // what this scene must accomplish
  cast:       EntityDossier[];     // rendered AS OF this scene
  setting:    EntityDossier[];
  facts:      FactStatement[];     // reader-visible ∪ POV-known, filtered
  knowledge:  { povKnows: string[]; povDoesNotKnow: string[] };
  continuity: { previousSceneTail: string;      // verbatim, for voice carry-over
                recentSummaries: string[];      // last N scenes
                chapterSummaries: string[];     // compressed further back
                arcState: ArcStatus[] };
  laws:       CompiledLaw[];       // scoped, ordered by severity
  style:      { exemplars: string[]; voiceNotes: string };
  semantic:   RetrievedChunk[];    // the supplementary vector pass
  budget:     { model; contextWindow; allocated: Record<Section, number>;
                used: Record<Section, number> };
}
```

## Compilation algorithm

**Step 1 — Seed.** Collect hard links from the scene row: POV character, location,
cast (confirmed mentions plus manually pinned entities), linked beats, and the
arcs those beats belong to.

**Step 2 — Expand one hop.** From each seed entity, traverse `entity_relationship`
where the relationship is active at this scene's rank. One hop, not two —
two-hop expansion pulls in the whole world and defeats the purpose. Second-hop
entities are admitted only if they also appear in this scene's beats.

**Step 3 — Temporal filter on facts.** For each entity in the working set, select
facts where:
- `established_at` is NULL or `established_at.global_rank <= scene.global_rank`, and
- `invalidated_at` is NULL or `invalidated_at.global_rank > scene.global_rank`, and
- the fact is not superseded by a later active fact.

**Step 4 — Spoiler filter.** Keep a fact only if:
- `revealed_at.global_rank <= scene.global_rank` (the reader knows it), **or**
- `is_dramatic_irony` and it is established (reader knows, characters don't), **or**
- the POV character has a `fact_knowledge` row with `known_from <= scene`.

Facts that pass only via POV knowledge are labelled *known to POV, not yet to the
reader*. Facts failing all three are excluded — and the ones with
`spoiler_weight >= 2` are additionally listed in a **negative constraints** block:
"do not reveal, hint at, or foreshadow X." Silence is not enough; models
confabulate into gaps. Naming the forbidden thing *as forbidden* works better,
and is the one place we deliberately spend tokens on what the model must not say.

**Step 5 — Render dossiers.** Each entity becomes a dossier sized by
`importance`: protagonists get full description plus filtered facts plus voice
notes; background entities get their one-line `summary` and nothing else.

**Step 6 — Continuity ladder.** Hierarchical compression, not a flat window:
the previous scene's final ~300 words verbatim (so prose voice carries across the
seam), then summaries of the previous 2–5 scenes, then chapter summaries for the
current act, then a one-paragraph book-so-far. Cost grows logarithmically with
novel length instead of linearly.

**Step 7 — Semantic supplement.** Vector search over scene summaries, facts and
notes, seeded by the scene's purpose and beat text, excluding anything already
included and anything the spoiler filter rejected. Take the top few. This is the
safety net for connections the writer never linked — deliberately last, and
deliberately small.

**Step 8 — Laws.** Gather laws whose scope covers this scene, ordered `must` →
`should` → `prefer`. Canon laws derived from step 4's facts are appended.

**Step 9 — Budget.** Given the target model's context window, allocate:

| Section | Default share |
|---|---|
| Laws (must) | never trimmed |
| Beat targets | never trimmed |
| POV + cast dossiers | 25% |
| Facts | 20% |
| Continuity ladder | 25% |
| Style exemplars | 10% |
| Semantic supplement | 10% |
| Headroom for output | 10% |

Trimming is by priority within each section (importance, spoiler weight, recency),
never a blind truncation. When the model is a small local one, the same algorithm
simply produces a tighter brief — which is exactly why local support is a config
change rather than a project.

## The extraction loop — how the graph fills itself

The objection to structured lore is data entry. The answer is to harvest it.

When prose is accepted, the `extract` role runs (cheap or local model, structured
output) over the new text and proposes:
- new entities (with a suggested type and aliases),
- new facts, with `established_at`/`revealed_at` set to this scene,
- new `fact_knowledge` rows ("Maren learns here that the seal is broken"),
- mentions the alias matcher missed,
- a one-line scene summary and a tension rating.

Everything lands in a **review queue** as unconfirmed rows with `source =
'extracted'`. The writer accepts, edits or rejects — bulk accept for the obvious
ones. Nothing unconfirmed ever enters a brief as canon. Write the book, and the
codex grows behind you.

## Reader-facing payoff

Because the graph knows both truth-time and reveal-time, three high-value views
come free:

- **"What does the reader know at chapter 14?"** — the reader's-eye state.
- **"What does Maren know?"** — essential for writing her POV honestly.
- **Setup/payoff ledger** — facts planted but never paid off, and reveals that
  land before their setup.
