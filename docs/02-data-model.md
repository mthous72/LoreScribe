# Data Model

The whole application is a view over one graph. This document explains the shape;
`db/schema.sql` is the executable version.

---

## 1. Narrative position — the spine

Almost every temporal question ("is this known yet?", "has this happened?") is
answered by comparing two points in the narrative. So position must be cheap,
totally ordered, and stable under reordering.

**Decision:** the ordered unit is the **scene**. Every scene carries a
`sort_key TEXT` (LexoRank-style: `a0`, `a0m`, `a1`…) that gives a total order
across the whole book without renumbering siblings on every drag. Chapters and
parts carry their own sort keys; a scene's global position is
`(part.sort_key, chapter.sort_key, scene.sort_key)`, materialised into
`scene.global_rank` on write.

Anything that needs a timestamp stores a **scene reference**, not a number:

```
established_at_scene_id  -- becomes true in the world at/just before this scene
revealed_at_scene_id     -- the reader learns it at this scene
```

Reorder a chapter and every temporal relationship follows automatically. This one
choice is why the spoiler filter stays correct through restructuring.

**Story time is a separate axis.** `scene.story_time_start` / `story_time_end`
are integers of in-world minutes since a project epoch, rendered through an
optional custom `calendar`. Narrative order ≠ chronological order — that's what
makes flashbacks, parallel timelines and non-linear structures representable, and
it's what lets the timeline view show two tracks.

---

## 2. Structure

```
project ─┬─ book ─┬─ part (act)  ─┬─ chapter ─┬─ scene ─┬─ scene_version
         │        │                                     └─ mention
         │        └─ arc ─ beat ─ beat_scene ────────────┘
         ├─ entity ─┬─ entity_alias
         │          ├─ entity_relationship
         │          └─ fact ─ fact_knowledge
         ├─ law
         ├─ timeline_event
         └─ ai_run
```

`project` is the series container. **Multi-book support is in from day one** —
retrofitting a shared codex across a trilogy after the fact is a migration you
don't want. A `book` scopes the manuscript; `entity` and `law` scope to the
project, with optional per-book visibility.

`scene` holds the prose (`content_json` for the Tiptap document, `content_text`
denormalised for search/FTS/token counting). `scene_version` is an append-only
history: every AI generation, every manual snapshot, every accepted revision.
Branching ("what if") is just two sibling versions with `is_active` on one.

---

## 3. Entities — the codex

One table, typed, rather than a table per kind. Types ship as a seeded registry
so users can add their own:

| Type | Examples of type-specific attributes |
|---|---|
| `character` | age, species, occupation, pronouns, voice profile, wants/needs/lie/wound |
| `location` | parent location, climate, population, governing faction |
| `faction` | leader, allies, enemies, ideology, resources |
| `item` | owner, origin, powers, current location |
| `species` | lifespan, traits, homeland |
| `system` | (magic/tech) rules, costs, limits, who can use it |
| `language` | phonology notes, sample lexicon, naming rules |
| `event` | (historical) participants, consequences |
| `concept` | in-world terms, religions, customs, currencies |
| `theme` / `motif` | statement, expressions, carrier scenes |

Shared columns: `name`, `summary` (one line — used in compact briefs),
`description` (prose), `attributes JSON` validated against the type's schema,
`portrait_uri`, `importance` (protagonist / major / minor / background — drives
context budget), `status`, `spoiler_level`.

### Aliases matter more than they look
`entity_alias` (`"Kaelen"`, `"the Grey Warden"`, `"Captain"`, `"her brother"`)
powers three things at once: entity linking over prose, `@`-autocomplete, and
alias-aware rename. An alias can itself be time-bounded and spoiler-bearing —
"the Grey Warden" may not be connectable to Kaelen until chapter 20.

### Relationships are time-bounded
`entity_relationship(from, to, kind, since_scene, until_scene, strength, notes)`.
`kind` is an open vocabulary (`parent_of`, `serves`, `loves`, `located_in`,
`owns`, `rules`, `member_of`, `enemy_of`). Time bounds are what make "Maren and
Kaelen are allies (ch.1–ch.18), then enemies (ch.18–)" queryable, and they feed
the relationship graph view.

---

## 4. Facts — the crown jewel

An atomic, timestamped, attributable claim about the story world.

```sql
fact(
  id, project_id, subject_entity_id,
  predicate,              -- 'eye_colour', 'is_traitor', 'located_in', free text ok
  object_text,            -- literal value
  object_entity_id,       -- or a reference to another entity
  statement,              -- human-readable rendering for prompts
  established_at_scene_id,-- NULL = true from the beginning (backstory)
  revealed_at_scene_id,   -- NULL = never revealed on the page
  invalidated_at_scene_id,-- when it stopped being true
  supersedes_fact_id,     -- chain of changing truth
  certainty,              -- canon | planned | speculative
  spoiler_weight,         -- 0-3, how damaging early exposure is
  source,                 -- manual | extracted | ai_suggested
  confirmed
)

fact_knowledge(fact_id, entity_id, known_from_scene_id, belief)
  -- belief: knows | suspects | believes_false | told_but_disbelieves
```

**What this buys you, all from one table:**

- **Spoiler-safe prompting.** When compiling a brief for scene S, include a fact
  only if `established_at <= S` and (`revealed_at <= S` or the POV character
  appears in `fact_knowledge` with `known_from <= S`). Dramatic irony is an
  explicit override flag, not an accident.
- **Contradiction detection.** Two active facts with the same subject+predicate
  and different objects, overlapping in time, is a mechanical query.
- **Setup / payoff ledger.** A fact with `revealed_at` set but no scene that
  mentions it is an unpaid Chekhov's gun. A fact revealed before it's established
  is a continuity error.
- **"What does Maren know?"** A first-class view, directly usable when writing
  her POV.
- **Character sheets that change.** The dossier rendered for chapter 4 is
  genuinely different from the one for chapter 34, from the same record.

---

## 5. Mentions — linking prose to the graph

`mention(scene_id, entity_id, start_offset, end_offset, alias_used, confidence,
confirmed, is_pov)`.

Produced three ways: explicit `@` insertion by the writer, alias matching on
save (cheap, deterministic, covers most of it), and an optional LLM pass for
pronouns and indirect reference. Unconfirmed low-confidence mentions surface in a
review queue rather than silently polluting the graph.

Mentions give you backlinks ("47 scenes feature Kaelen"), presence timelines,
"characters in this scene" without manual tagging, and the raw material for
continuity checks.

---

## 6. Arcs and beats

```
arc(id, book_id, kind, name, owner_entity_id, colour, sort_key,
    premise, want, need, lie, ghost, change_from, change_to)
    -- kind: main_plot | subplot | character | relationship | mystery | theme
beat(id, arc_id, sort_key, title, summary, function, tension 0-10,
     target_chapter_id, status, template_beat_key)
beat_scene(beat_id, scene_id, role)  -- setup | develop | payoff | echo
```

Many-to-many on purpose: one scene usually advances several arcs, and one beat
sometimes spans several scenes. That join table is what kills plan/prose drift —
it makes "unrealised beats" and "scenes serving no arc" both one query away.

`template_beat_key` ties a beat to a structure template slot (Save the Cat's
"Midpoint", Story Circle's "Search"), so a book can be checked against, or
generated from, a chosen skeleton without being locked to it.

---

## 7. Laws

```
law(id, project_id, scope_type, scope_id, category, severity, title, rule_text,
    check_mode, check_config, examples_good, examples_bad, active, sort_key)
```
Scoped to project / book / arc / chapter / scene / entity / POV. Categories:
`canon`, `style`, `voice`, `structure`, `content`, `ip`. See
`docs/04-laws-engine.md`.

---

## 8. AI provenance

`ai_run(id, project_id, scene_id, purpose, provider, model, params JSON,
brief_json, prompt_rendered, output_text, tokens_in, tokens_out, cost_usd,
latency_ms, laws_checked, violations JSON, accepted, created_at)`.

Every call is recorded with the **exact compiled brief**. This is not analytics
garnish — it is how you debug "why did it write that," how the cost meter works,
how a run is re-run against a different model for comparison, and how a regression
suite of real prompts gets built.

---

## 9. Sync-readiness (even though v1 has no server)

Every row carries `id TEXT` (UUIDv7), `created_at`, `updated_at`, `deleted_at`
(soft delete) and `rev`. All writes also append to `op_log(entity_table, row_id,
op, payload, ts, device_id)`. Nothing in v1 reads `op_log` except export — but
having it from the first commit is what makes an optional sync service a feature
rather than a rewrite.

---

## 10. Search and embeddings

- **FTS5** virtual tables over `scene.content_text`, `entity.description`,
  `fact.statement`, `note.body` — instant, offline, free.
- `embedding(owner_table, owner_id, chunk_index, vector BLOB, model, dims)` for
  the supplementary semantic pass. At novel scale (~2–5k chunks) a brute-force
  cosine scan in WASM is measured in milliseconds; `sqlite-vec` is the upgrade
  path if a project outgrows that. Embeddings can be produced locally
  (ONNX/transformers.js) even when drafting through OpenRouter, so semantic
  search keeps working offline and costs nothing.
