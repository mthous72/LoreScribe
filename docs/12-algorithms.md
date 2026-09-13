# Algorithm specifications

[D10](10-decisions.md) is ideas-only: nothing is ported, everything is written
fresh. That is clean legally and cleaner architecturally — but it only works if the
ideas are captured precisely enough to build from. Otherwise "we learned that from
LibriScribe" degrades into a vague memory three weeks later.

So this document is the **specification**. It is the implementation reference for
the non-obvious algorithms; the source repositories are not. Nothing here is a
transcription — these are behaviour specs written in our own terms, with the
parameter choices recorded because *which* values work is the expensive knowledge.

Each section is written to be implementable in TypeScript by someone who has never
opened the projects in docs 09 and 11.

---

## 1. Repetition guard

**Why:** models — small local ones especially — reuse distinctive imagery and open
consecutive scenes the same way. Generic instruction ("vary your imagery") does not
fix it. Explicit named bans do. See [doc 04](04-laws-engine.md).

### 1.1 Building the ban list (input: all prose written so far)

**Tokenise.** Strip heading and scene-marker lines first — scaffolding must never
enter the analysis. Split remaining text into paragraphs, then sentences (on
`.!?` followed by whitespace). Reduce each sentence to a lowercased array of word
tokens (letters plus apostrophes). **N-grams never span a sentence or paragraph
boundary** — one of the cheapest correctness wins here, and easy to omit.

**Identify proper nouns.** Any capitalised word occurring mid-sentence (not after
`.!?"'` + whitespace, not at line start). Collect lowercased. These are names and
places that recur legitimately — **they must never be bannable**, or the guard
starts forbidding the protagonist.

**Count n-grams** of length 3–5 across all sentences.

**Content word** = a token that is neither a stopword nor a proper noun. Maintain
a stopword list of function words, common contractions and generic pronouns —
roughly 150 entries; content is not sensitive to its exact membership.

**Qualification threshold** — a phrase is a ban candidate if:
- it occurs **≥ 2 times** and contains **≥ 2 content words**, or
- it occurs **≥ 3 times** and contains **≥ 1 content word** (catches short, loud
  repeats like "as if burned").

**Rank** by occurrence count descending, then by phrase length descending (prefer
the fuller wording among equally frequent candidates).

**Deduplicate by containment:** skip a candidate that is a substring of, or
contains, an already-kept phrase.

**Merge staggered fragments.** A repeated phrase longer than the 5-gram window
surfaces as several overlapping fragments — `a heavy sheet of` / `heavy sheet of
corrugated` / `sheet of corrugated plastic`. Chain-merge any two kept phrases whose
tail and head overlap by **≥ 2 words**, in either direction, repeating until no
merge applies. Then drop any phrase contained in a longer one. Without this the ban
list is three-quarters duplicates and burns budget.

**Cap at ~12 phrases.**

**Overused single words** (invisible to the phrase detector — one word repeated 19
times in a chapter): count tokens longer than 3 characters that are neither
stopwords nor proper nouns; threshold is `max(6, floor(totalWords / 1000 * 2.5))`;
take the top 10.

**Scene openings:** the first sentence of each of the last ~6 scenes.

### 1.2 Rendering into the prompt

Three labelled blocks, phrased as hard constraints rather than preferences:
banned phrases ("you are BANNED from using these or close variants"), overused
words ("use each at most once — find different words"), and prior scene openings
("your scene must open differently — a different sense, subject and sentence shape
than all of these"). Return empty when there is nothing to guard against.

### 1.3 Post-generation check (deterministic, no model)

Normalise both the new scene and each banned phrase to lowercase word sequences,
then test containment. For the opening, compare the new scene's first sentence
against each prior opening with a similarity ratio (longest-common-subsequence
style, as `difflib.SequenceMatcher` computes); **flag at ≥ 0.6**.

Violations are named explicitly and fed into **exactly one** regeneration attempt.
One retry, not a loop — a second failure is a signal about the model or the scene,
not something to burn tokens on.

### 1.4 Revision mode

The same detector, reframed: instead of a ban list for the next scene, a
fix-this report over an existing chapter ("keep at most one occurrence of each and
rewrite the rest").

---

## 2. Prose sanitation

Deterministic, idempotent, pure. Applied to **every** generated or revised span
before it is stored or displayed. Order matters.

1. **Strip reasoning blocks.** Remove `<think>…</think>` and `<reasoning>…</reasoning>`
   spans, case-insensitive, dot-matches-newline. **Streaming needs a separate state
   machine**, because the tags straddle chunk boundaries: buffer on a partial
   opening tag, suppress output while inside, resume after the closing tag, and
   flush the buffer at stream end if no closer ever arrived.
2. **Repair mojibake.** This is UTF-8 bytes decoded as cp1252. Rather than
   hardcoding a substitution table, **generate the mapping at startup** by taking
   each non-ASCII character of interest, encoding UTF-8, and decoding cp1252 — the
   result is exactly the corrupted form to search for. Apply longest-first.
   Handle two lossy variants the round-trip misses: a lone `â` wedged between two
   letters (an em dash whose trailing bytes were dropped) and a stray `Â` adjacent
   to whitespace.
3. **Strip scaffolding.** Remove leading `Scene N:` label lines in any of their
   bold/heading variants. Then, if the first remaining line merely restates the
   scene's own summary, drop it — test by similarity **≥ 0.7**, or by either string
   being a prefix of the other when longer than 20 characters.
4. **Normalise punctuation.** Runs of 2+ hyphens become an em dash — but skip
   markdown horizontal rules and list items. Collapse spaces around em dashes.
   Remove a hyphen glued to a capital or opening quote at line start or after a
   sentence break (a model tic; a real list item always has a space after the
   hyphen). Fix `NAME'S` → `NAME's` after an all-caps word.
5. **Normalise whitespace.** Strip trailing spaces per line, collapse 3+ blank
   lines to one blank line, trim leading/trailing newlines.

Running it twice must equal running it once. Test that property directly.

---

## 3. Evidence verification

The cross-cutting anti-hallucination rule: **any AI claim about the manuscript must
cite a span that is verifiably present in it.**

Normalise both the citation and the source text identically — lowercase, curly
quotes to straight, en/em dashes to hyphen, collapse all whitespace runs to a
single space. Then require the citation to be a **substring** of the source, and to
be at least **12 characters** after normalisation (shorter fragments match by
accident).

On failure the verdict is **downgraded to `uncertain`**, with a note explaining the
citation could not be located. It is never accepted, and never silently dropped —
the reviewer needs to know the model asserted something it could not support.

Applies to: extracted facts, extracted knowledge rows, thread detection, law
violations from rubric checks, beat-coverage verdicts, and continuity findings.

---

## 4. Reasoning-model token allowance

Reasoning models spend tokens in a private channel *before* answering — measured at
roughly **2,500 tokens for a two-sentence request**. A budget sized for the answer
is consumed entirely, and the content comes back empty or truncated. The failure is
silent and looks like a broken provider.

**Policy:**
- Maintain `observedReasoning: Map<modelId, number>`, persisted to
  `model_profile.reasoning_allowance`.
- Read the response's reasoning token count where the provider reports it; where it
  doesn't, estimate from the length of any reasoning content field (~3 characters
  per token) as a floor.
- Keep the **worst case** seen per model, plus a margin.
- Add it preemptively to `max_tokens` on every subsequent request to that model.
- On a truncated response with non-zero reasoning tokens, **escalate and retry up
  to twice**. Ordinary truncation with no reasoning spend is not this problem and
  must not trigger the escalation path.
- **Streaming cannot retry**, so apply the current allowance up front there.

Record `tokens_reasoning` and `budget_escalations` on `ai_run` — the allowance is
only learnable if it's measured.

---

## 5. Grammar-constrained structured output

An OpenAI-style `response_format: {type: "json_schema", …}` compiles to a GBNF
grammar on llama.cpp-backed servers and constrains decoding at the token level, so
a small local model **cannot** emit a fence, a preamble or a missing key. Prefer it
everywhere; keep JSON repair as the fallback, not the first line of defence.

Two rules that are easy to get wrong:

**Required-but-empty.** Mark every field `required` and type it `string`. The
grammar then guarantees the key exists, while an empty string still satisfies it —
so **the constraint never forces a hallucinated value**. Marking a field optional
gets it omitted; making it required with a non-string type forces the model to
invent something. This distinction produces confident garbage when missed.

**Strict-mode detection.** OpenAI's `strict: true` requires *every* object in the
schema to set `additionalProperties: false`. Schemas that intentionally allow extra
keys must therefore be non-strict or the provider rejects them outright. Walk the
schema recursively and set `strict` to whether every nested object is closed.
Degrade to `{type: "json_object"}` for providers with JSON mode but no schema
support, and to prompt-only plus repair for the rest.

---

## 6. Word counting

Must match what writers see elsewhere, or every number the app reports becomes
suspect — goals, stats, and context budget estimates alike. One implementation,
used everywhere.

Strip formatting shortcodes and inline markup. Skip meta lines (those beginning
with the comment or keyword sigil). Strip block-quote markers. **Treat en and em
dashes as word separators** — `word—word` is two words, and naive splitting counts
one. Then count paragraphs (blank-line separated), words, and characters.

Test against fixed reference files with hand-verified counts, not against itself.

---

## 7. Readability and pacing statistics

All offline, no dependencies, no model.

- **Syllables** (English heuristic): lowercase and strip non-letters; words of ≤ 3
  letters count as 1; strip a trailing silent `e`, `es` or `ed` (not after `l`);
  strip a leading `y`; count remaining vowel groups (`[aeiouy]+`); floor at 1.
- **Flesch Reading Ease** = `206.835 − 1.015·(words/sentences) − 84.6·(syllables/words)`
- **Flesch–Kincaid Grade** = `0.39·(words/sentences) + 11.8·(syllables/words) − 15.59`
- **Dialogue ratio**: characters inside paired double quotes (straight and curly
  normalised) over total characters. Track quote state across the text rather than
  regex-matching pairs, so unbalanced quotes degrade gracefully.
- **Adverb ratio**: `-ly` words over total words. Crude, and useful anyway.
- **Reading time** at ~220 wpm.

Report per scene, per chapter and per book. Present as diagnosis, never as a score
— see [doc 07 §E](07-suggestions-backlog.md).

---

## 8. Structural gap finder

Deterministic, no model, fast enough to run on every save. Each gap:
`{id, type, severity, entityType, entityName, message, evidence, target}` — where
`target` makes the row click-to-open.

Types: **dangling reference** (a name used in a relational field with no matching
entity or alias); **out-of-range reference** (a beat targeting a chapter that
doesn't exist); **unresolved thread** and **unresolved arc** past their intended
resolution point; **thin entity** (missing the fields the brief compiler actually
consumes — a character with no summary contributes nothing to a dossier); **missing
voice profile** on a speaking character; **orphan scene** (serves no beat);
**unrealised beat** (no scene). The last two already exist as SQL views.

Build this *before* the AI continuity checker. It is free, instant, and catches a
surprising share of real problems.

---

## 9. Sort keys and index rebuild

**Sort keys.** Scenes, chapters, parts, arcs and beats order by a
lexicographically-sortable string key (LexoRank style: `a0`, `a0m`, `a1`), so
inserting between two siblings mints a midpoint key without renumbering anything.
Rebalance only when a key exceeds a length threshold. `scene.global_rank` is the
materialised `part|chapter|scene` triple and is **derived** — recomputed on any
structural move, and rebuildable wholesale.

**Index rebuild.** `mention`, `scene_fts`, `embedding` and `scene.global_rank` are
caches ([doc 02 §9b](02-data-model.md)). Each carries an algorithm revision in
`index_state`. Bump the revision when the producing algorithm changes; existing
rows are stale by definition and get rebuilt. A full rebuild must always be
available and always safe — settings button, not support incident.
