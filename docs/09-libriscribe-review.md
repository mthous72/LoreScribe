# Review: what to take from LibriScribe

Source: [`mthous72/libriscribe`](https://github.com/mthous72/libriscribe) — a fork of
Fernando Guerra's LibriScribe, ~10k lines of Python across 298 files, 40+ backend
tests, FastAPI + React, shipping as a Windows installer.

This is not a competitor's codebase to be surveyed politely. It is several
versions' worth of **empirically discovered failure modes**, many of them recorded
in the docstrings, and a number of them are things the LoreScribe plan would have
had to rediscover the hard way. A few of its findings contradict assumptions in
the current plan.

---

## The headline

The two projects converged independently on the same three ideas — **token-budgeted
context assembly**, **prompt preview before spending a token**, and
**per-character knowledge state** (`char_state.py` builds a "who learns what,
when" timeline and a `knows_too_early` check). That convergence is the strongest
evidence available that the diagnosis in doc 00 is right.

Where they diverge, the split is clean:

- **LoreScribe's plan is better at representation** — scene-reference temporality
  that survives reordering, `revealed_at` distinct from `established_at`, atomic
  facts, mentions with offsets, relational storage.
- **LibriScribe is far ahead on everything downstream of the model call** —
  output hygiene, local-model reliability, determinism, and the human-approval
  discipline around AI proposals.

The second list is the part you cannot design your way to. It has to be
discovered by shipping.

---

## Tier 1 — Adopt outright; these beat what was planned

### 1. Evidence-quote verification with auto-downgrade
`milestone_verifier.py` asks the model to grade whether prose *actually delivered*
a planned beat, and to cite an exact quote as evidence. Then:

```python
if delivered and not _evidence_in_prose(evidence, prose):
    proposed = "uncertain"
    reasoning += " (Downgraded: the cited evidence is not an actual quote.)"
```

Normalised substring match — smart quotes, dashes and whitespace folded, minimum
12 characters. A fabricated quote downgrades the verdict rather than being
believed.

**This is a general anti-hallucination primitive, not a milestone feature.** It
should be a cross-cutting rule in LoreScribe: *any AI claim about the manuscript
must cite a span that is verifiably present in the manuscript.* That covers
continuity findings, law violations, extracted facts, beat-coverage verdicts and
thread resolutions. The current plan stores `law_violation.quote` but never checks
that the quote is real — which is precisely the failure this guards against, and
it gets worse the smaller the model.

### 2. The repetition guard belongs at generation time, not in analysis
The plan filed repetition detection under backlog item A4 — a nice-to-have
analysis pass. `repetition_guard.py`'s docstring says otherwise, from a measured
bake-off: a chapter "opened 3 of 5 scenes with the same establishing shot and
reused 'heart hammering against his ribs' four times despite the continuity
rules."

Its architecture is exactly the Laws Engine's two-phase shape, arrived at
independently:

1. Scan prose so far → extract overused n-grams, overused single words, and each
   prior scene's opening sentence → render as an explicit **named ban list** in
   the next prompt.
2. After generation, deterministically check for violations → **regenerate once
   with the violations named**.

And the load-bearing insight, stated plainly: *instruction-only steering
("don't reuse imagery") is too weak for small models, but small models do follow
explicit named bans.* That is the entire justification for the Laws Engine's
verification phase, confirmed by someone who measured it.

The implementation details are not obvious and are worth porting verbatim:
- proper nouns excluded from ban candidates, so character names never get banned;
- n-grams never span sentence or paragraph boundaries;
- staggered fragments of a long phrase chain-merged back into the full phrase;
- scene-opening similarity at `SequenceMatcher` ratio ≥ 0.6;
- the same detector re-framed as a *fix-this report* for revision passes rather
  than a ban.

**Action:** repetition becomes a built-in `style` law with `check_mode: heuristic`,
and the ban-list block becomes a first-class Scene Brief section.

### 3. A deterministic prose sanitiser on every generated span
`prose_sanitizer.py` — entirely absent from the LoreScribe plan, and mandatory the
moment local models are in scope:

- `<think>` / `<reasoning>` block stripping, **including across streaming chunk
  boundaries** (there's a dedicated streaming state machine for this — a trap that
  only shows up once you stream a reasoning model);
- UTF-8-read-as-cp1252 mojibake repair with a longest-first replacement table,
  plus the lone-`â`-between-letters case where an em dash lost its trailing bytes;
- outline/summary echo removal — a generated scene whose first line just restates
  its own summary, matched at similarity ≥ 0.7;
- `Scene N:` label lines the model emits despite instructions;
- dash normalisation, stray leading hyphens, `CEE'S` → `CEE's` caps tics.

Idempotent pure functions. **Scaffolding must never reach the reader** is the
principle, and there is no prompt that achieves it reliably.

### 4. Reasoning models need a learned token allowance
`llm_client.py` carries `self._observed_reasoning: Dict[str, int]`. The recorded
observation: **~2,500 thinking tokens for a two-sentence ask.** A budget sized for
the answer gets consumed by the private think channel and the content comes back
empty or truncated.

The fix: read `reasoning_tokens` from the response, remember the worst case per
model, add it preemptively to every later request, escalate the budget up to twice
on truncation — and because **streaming cannot retry**, apply the allowance up
front there.

The plan's `ModelCapabilities` has no concept of thinking cost. This is a
silent-failure class that would have cost a week in Phase 7. Add
`reasoningAllowance` to the capability model and persist the observed value per
model profile.

### 5. Grammar-constrained structured output
The plan said "fall back to a parse-with-repair path" for local models.
`structured_output.py` is better: an OpenAI-style
`response_format: {type: "json_schema"}` **compiles to a GBNF grammar on
llama.cpp-backed servers and constrains decoding at the token level** — a small
local model then *cannot* emit a fence, a preamble, or a missing key.

Two non-obvious details worth taking:
- `_all_objects_closed()` auto-detects whether a schema qualifies for OpenAI's
  `strict` mode (every object must set `additionalProperties: false`), because
  strict providers reject open schemas.
- Mark every field **required** but typed `string`: the grammar guarantees the key
  exists, while an empty string still satisfies it — so **constraint never forces a
  hallucinated value**. That distinction is easy to get wrong and produces
  confident garbage when you do.

Repair stays as the universal fallback, not the first line of defence.

---

## Tier 2 — Adopt the concept; LoreScribe's schema generalises it

### 6. Reference material as a separate, non-canon source band
Missing from the plan entirely, and it's a genuine gap. LibriScribe lets you
import PDF/TXT/Markdown — and scanned PDFs/images via bundled OCR — as a distinct
**source type** that grounds brainstorming and generation but *never becomes
canon* and is *excluded from exports*.

The context builder reserves its slice **first**, so canon context can't crowd it
out, and labels it unmistakably:

```
=== REFERENCE MATERIAL (imported source — use as background/citation, NOT canon) ===
```

Canon retrieval meanwhile filters it out (`exclude_source_type: ["reference"]`).
For historical, technical, legal or medical fiction this is the difference between
a toy and a working tool. It also pairs with the `ip` law category: reference
material is for *consultation*, never reproduction — so the regurgitation check
should run specifically against imported references.

**Action:** add `reference_source` / `reference_chunk` tables, a `source_band`
discriminator on `embedding`, a reserved brief section, and export exclusion.

### 7. State the no-cascade guarantee as a product principle
> *"Edit early, never break late — editing an item never regenerates anything
> downstream; impact hints show where an entity is referenced later."*

`impact.py` is a word-boundary regex scan answering "where is this entity
referenced later?", explicitly advisory: "no edit endpoint ever triggers
regeneration."

LoreScribe computes this for free and more accurately — it's a `mention` query,
not a regex scan — but the plan never stated the **principle**, and the principle
is what earns trust. A writer will not let an AI tool near 80,000 words if editing
chapter 3 might silently rewrite chapter 30. Put it in the product rules.

### 8. Narrative threads as a first-class, auto-detected type
`thread_tracker.py` runs after each chapter, detects new **promises, setups,
questions and items**, marks previously-open threads resolved, and warns about
unresolved threads before the final chapter.

The plan derives a setup/payoff ledger from `fact.revealed_at` — which is the
right *storage*, but facts and promises aren't the same thing. "Someone is
watching the house" is a promise to the reader, not a fact about the world. Both
are needed: threads for reader-facing promises, facts for world truth.

Take the four-type taxonomy directly, plus `opened_chapter` /
`target_resolution_chapter` / `resolved_chapter`, translated to scene references.

### 9. Character state extraction — keep their prompt, keep our schema
`char_state.py` independently arrives at `fact_knowledge`. Its
`knowledge_timeline_block()` renders:

```
CHARACTER KNOWLEDGE TIMELINE (who learns what, when):
- Ch 4: Maren learns: the seal is broken
...
If a chapter shows a character ACTING ON or REFERRING TO information before the
chapter where they learn it, report it as note_type "knows_too_early".
```

Their storage is per-chapter snapshots keyed by integer; ours is per-fact with
scene references, which is finer-grained and survives reordering — so keep our
schema. But take:
- the **extraction prompt shape** ("`knowledge` = NEW information the character
  LEARNS in this chapter"), which is already tuned;
- the **rendered block format** and the `knows_too_early` check name;
- **idempotent re-scan** — re-extracting a chapter first deletes that chapter's
  previous snapshots, so re-runs converge instead of duplicating.

### 10. The deterministic gap finder
`gap_finder.py`, zero LLM calls: dangling references (a name in a relational field
with no matching record), out-of-range chapter numbers, unresolved arcs and
threads, "thin" characters missing the fields the writing pipeline actually
consumes, missing voice profiles. Each gap carries a stable id, severity, a
one-line message, evidence, and a click-to-open target.

The plan has an AI continuity checker but no free deterministic tier. This one is
fast, unit-testable and can run on every save. Build it first; the LLM checks are
the expensive second tier.

### 11. Sandbox staging, spelled out properly
`sandbox.py` is the review queue, better specified than the plan's version:
per-run staging files, candidates carrying `op: new|update`, `status:
pending|accepted|rejected`, plus `source`, `rationale`, `confidence` and
`evidence`. The locked decision is stated outright: **"Candidates NEVER touch the
live KB until the author explicitly accepts them."** Per-run granularity means a
whole bad extraction run can be abandoned in one action.

### 12. Smart merge semantics — the detail that makes extraction safe
> *"existing entries are updated field-by-field — empty fields filled, revised
> fields updated, and anything not mentioned is preserved (never overwrites
> untouched data)."*

The plan said "review queue" and left merge semantics undefined. This is the rule
that stops an extraction pass from quietly destroying hand-written lore, and it
needs to be in the spec, with tests.

### 13. Ground the *planning* stages in existing lore, not just the scenes
`lore_digest.py` builds a budgeted digest of established lore and injects it into
concept and outline generation, wrapped in an instruction that makes it binding:

> *"This story belongs to the world above. Use these characters, arcs, places and
> facts as the foundation — extend and deepen them. Do NOT invent replacements for
> them, rename them, or contradict them. Only introduce new elements where the
> established lore has gaps."*

The LoreScribe plan is entirely scene-level. Nothing in it stops outline
generation from inventing a parallel world that contradicts the codex. A
`LoreDigest` compiler — the Scene Brief's sibling for structural work — is a real
missing component.

### 14. `canon_rules`: bracket-and-restate
Their proto-Laws. The Laws Engine supersedes the feature, but steal the prompt
shape: explicit open/close delimiters around the block, then **restate the
bindingness after it** — "These rules are absolute. Every line you write must
comply with them." Adherence to a fenced-and-restated block measurably beats a
bare list, and it costs nothing.

---

## Tier 3 — Take the UX and the small mercies

15. **The three-pane Story Workbench** — ordered story tree · per-item editor ·
    brainstorm chat docked right with focus following the selection; Prev/Next to
    walk the story in order; **every selection is a shareable URL**
    (`?sel=scene:3.2`). Concrete and better than the plan's vague "split view".
    Deep-linkable selection is a small feature with outsized value.
16. **Small-bite actions, always propose → review → save, with a diff**, spliced
    back into just that scene's block (`scene_prose.py` handles split/splice at
    scene markers). Matches the plan's "targeted revision, never full rewrite" —
    they've built the splice machinery.
17. **Prompt/context preview before spending a token** — the brief inspector,
    independently invented. Good validation that it matters.
18. **Import SillyTavern character cards & World Info, KoboldAI World Info**,
    auto-detected, with an optional AI-map pass for unknown formats, all through
    the same review panel. Excellent interop; add alongside the planned Scrivener
    import.
19. **Prose register dial (1–5)**, gated behind opt-in + age affirmation, with the
    honest framing: "purely a generation steer; performs no filtering of model
    output." A cleaner user-facing control than a pile of content-law toggles —
    adopt the dial as the UI over the `content` law category.
20. **Multiple named parallel brainstorm sessions per book**, each with its own
    history and persistent Focus.
21. **Provider fallback chain as a config string** —
    `FALLBACK_CHAIN=claude,openrouter/anthropic/claude-3-haiku` with route parsing
    (`provider`, `provider/model`, or a bare model name). Nicer than the planned
    `fallback_profile_id` pointer for the common case.
22. **`normalize_openai_base_url()`** — append `/v1` when the user pastes a bare
    `http://localhost:1234`. Six lines; saves endless support pain.
23. **`stats_service.py`** — dependency-free Flesch / Flesch-Kincaid, syllable
    heuristic, adverb and dialogue ratios, reading time. Backlog item A4 in the
    plan; here it's written. Port the algorithm.
24. **Two operational lessons paid for in production:**
    - Cost logging is best-effort and **must never break a generation** — a
      logging exception inside the completion path made *every LLM call return
      `""`*.
    - The cause was a **relative default path resolved against a read-only CWD**
      (Program Files). User data belongs in an app-data dir, never the install
      dir. The Capacitor/OPFS equivalents deserve the same care.
25. **Prompt templates as external YAML** with per-template model and cost config,
    user-editable, falling back to hardcoded defaults. Matches the planned
    `prompt_template` table; the external-file approach is more hackable and
    doubles as user-facing transparency.

---

## What LoreScribe should *not* take

- **JSON knowledge-base files keyed by entity name.** Name-keyed merge forces
  `_canonical()` lowercase scans everywhere, makes renames hazardous, and can't
  express aliases. The relational model with an alias table is the fix.
- **Integer chapter numbers as the temporal unit.** Everything temporal breaks on
  reorder.
- **A single flat greedy token budget.** `ContextBuilder` consumes one
  `TokenBudget` in priority order, so the tail sections — arc milestones, open
  threads, character states, retrieval — are starved exactly when the book gets
  big enough to need them. (They already noticed and special-cased reference
  material to reserve its slice first; per-section allocation generalises that
  fix.) Keep the planned per-section allocator.
- **Recency as a spoiler proxy.** `_build_retrieval_context` filters retrieved
  chunks to chapters *before* the current one — but the lore, arc, thread and
  character-state sections are unfiltered, so anything in the KB leaks into any
  chapter's prompt. There is no reveal-state model. This is the specific gap
  `revealed_at` exists to close, and it's worth being explicit that it's the one
  structural thing LoreScribe does that LibriScribe cannot.

---

## The strategic question

LibriScribe is not a prototype. It is a working, tested, packaged application with
real users' books in it. So: should this be a new app at all, rather than
LoreScribe's features landing in LibriScribe?

**Assessment: build LoreScribe, port the utilities.**

The reason is narrow and specific. The differences that matter — scene-reference
temporality, atomic facts with distinct establish/reveal times, aliases, mentions
with offsets, many-to-many beat↔scene — are all **data model**, and LibriScribe's
model is name-keyed JSON documents. Retrofitting a relational temporal graph under
`ProjectKnowledgeBase` is not a refactor; it rewrites the core and invalidates
most of the 40 existing tests. Add the platform target — Android via Capacitor,
against a Python/FastAPI/PyInstaller stack — and the case closes.

But the reverse also holds, and it's the valuable half: **the hard-won parts are
pure, self-contained algorithms** — repetition guarding, prose sanitation,
structured-output shaping, gap finding, statistics, reasoning-budget policy. Their
value is not the code, it's knowing that they need to exist and which parameter
values work.

So they are **specified, not ported** ([D10](10-decisions.md)): written up as
behaviour specs in [doc 12](12-algorithms.md) and implemented fresh in TypeScript
in [Phase 0b](08-roadmap.md). That keeps LoreScribe unencumbered, produces code
that reads like the rest of the codebase, and still skips the months of discovery —
which was always the actual prize.

Worth deciding explicitly: whether LoreScribe can read a `.libriscribe.json`
bundle. Given both are yours, an importer is a few hours and makes the new app
immediately useful on existing books — which is also the only honest way to
A/B the thesis in Phase 2, by running both tools over the same manuscript.
