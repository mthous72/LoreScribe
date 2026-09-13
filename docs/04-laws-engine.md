# The Laws Engine

A "law" is a rule the AI must follow. The reason existing tools fail here is that
they treat rules as prose appended to a system prompt and never verify the output.
LoreScribe treats a law as a **scoped, typed, checkable constraint** with a
verification phase.

## Anatomy

```ts
interface Law {
  scope: { type: 'project'|'book'|'arc'|'chapter'|'scene'|'entity'|'pov';
           id?: string };
  category: 'canon'|'style'|'voice'|'structure'|'content'|'ip';
  severity: 'must'|'should'|'prefer';
  title: string;
  ruleText: string;            // phrased as an instruction to the model
  checkMode: 'prompt'|'regex'|'heuristic'|'rubric'|'prompt+rubric';
  checkConfig?: unknown;
  examplesGood?: string[]; examplesBad?: string[];
  isSystem: boolean;           // hard floor; not user-editable
}
```

Scoping is what keeps prompts short and adherence high. A voice law for Kaelen is
injected only when Kaelen is in the cast. A chapter-scoped structural law applies
to that chapter alone. The alternative — every rule in every prompt — is exactly
the "instruction buried at position 4000 gets dropped" failure.

## Categories

**`canon`** — derived automatically from the story graph, not typed by hand.
"Maren is dead as of chapter 18." "Kaelen cannot lie; it is physically impossible
for him." Generated from facts and magic-system entities, refreshed per brief.

**`style`** — the writer's prose rules. Tense and person; no adverbs in dialogue
tags; British spelling; scene breaks marked `***`; no em-dash pileups; avoid the
word "suddenly"; sensory detail in every setting change; show don't tell on
emotion words.

One `style` law ships built-in and earns its place: the **repetition guard**
(`check_mode: heuristic`). It scans the prose written so far for overused phrases
and words and for each recent scene's opening image, injects them as explicit named
bans, then deterministically checks the output and regenerates once with the
violations named. Proper nouns are excluded so character names are never banned,
and n-grams never span sentence boundaries. Instruction-only steering ("vary your
imagery") measurably fails on small models; named bans work. The same detector,
reframed as a fix-this report rather than a ban, drives revision passes.

**`voice`** — per character. "Kaelen never uses contractions." "Maren's
interiority is clipped, present-tense fragments." Scoped to `entity`, injected
only when relevant, and checkable by rubric against that character's dialogue.

**`structure`** — chapter length bands; end every chapter on a hook or turn;
one POV per scene; no scene shorter than 400 words; alternate POV by chapter.

**`content`** — the author's own ceiling. "Violence stays off-page." "No explicit
sex — fade to black." "No sexual violence." These are the writer's rails, freely
configurable, and the tool respects them as hard constraints on generation.

**`ip`** — see below.

## Enforcement is two-phase

**Phase 1 — Injection.** Applicable laws are compiled into the brief's laws block,
`must` first, in imperative form, with good/bad examples for the ones that have
them. `must` laws are never trimmed by the budget allocator.

**Phase 2 — Verification.** After generation, a compliance pass runs before the
text is offered for acceptance:

- `regex` — deterministic, free, instant. Banned words, `-ly` adverbs adjacent to
  dialogue tags, forbidden punctuation patterns.
- `heuristic` — computed. Word counts, POV-name leakage (a name that shouldn't be
  known to this POV appearing in narration), sentence-length variance, tense
  consistency, dialogue/narration ratio.
- `rubric` — a cheap-model call that receives the text plus the law and returns
  structured violations with exact quoted spans.

**Every rubric violation must cite evidence, and the evidence is verified.** The
quoted span is checked by normalised substring match (smart quotes, dashes and
whitespace folded; minimum 12 characters) against the actual prose. A violation
whose quote is not really in the text is downgraded to *uncertain* and never
reported as a finding. Models — small local ones especially — will confidently
invent a quote to justify a verdict, and an unverified citation is worse than no
finding at all because it looks authoritative.

Violations are written to `law_violation` and rendered inline in the editor as
underlined spans with the law, the reason and a suggested fix. The writer can
**auto-revise** (a targeted revision pass constrained to fix only the flagged
spans), fix manually, dismiss, or amend the law. That last option matters: a law
being violated constantly is often a law that's wrong, and the tool should make it
easy to say so.

Cost control: `regex` and `heuristic` checks run on every generation for free;
`rubric` checks run batched into a single utility-model call covering all rubric
laws at once, and can be set to run only on accept or only on demand.

## Content policy — the hard floor

A small set of `isSystem` laws is always active and not user-editable. These cover
what is actually illegal, and nothing else:

- No sexual content involving minors, in any framing, including age-ambiguous
  characters in sexual contexts.
- No real-world operational harm instructions presented as fiction (working
  synthesis routes, functional exploit code, weapon construction).
- No sexual content involving real, identifiable living people.

**Everything else is the author's call.** Dark, violent, morally repugnant,
politically uncomfortable, sexually explicit adult fiction — all of it is
legitimate, and the tool's job is to enable it, not to editorialise. Villains
should be genuinely menacing. The user-configurable `content` laws set the
ceiling; the system floor sets the only thing below it.

**The user-facing control is a register dial, not a checklist.** A 1–5 prose
register (restrained → suggestive → frank → graphic → unrestrained) is far easier
to set than a pile of toggles, and it maps onto scoped `content` laws underneath.
It is off unless enabled, gated behind an explicit opt-in and age affirmation, and
it is honestly a *generation steer only* — it changes the prompt, it does not
filter model output. Per-topic laws remain available for writers who want a
specific rail ("violence stays off-page") independent of overall register.

Note honestly in the UI: the *provider* also has a policy. When OpenRouter or a
given model refuses, LoreScribe reports the refusal as a provider refusal
(`ai_run.status = 'refused'`) rather than silently degrading, and suggests either
a model on OpenRouter with a more permissive policy or a local model. Being
straight with the writer about where a limit comes from is part of the product.

## IP and copyright laws

You asked for this explicitly, so it's a first-class category rather than a
disclaimer.

- **Named-style blocking.** Prompts of the form "write in the style of
  <living author>" are rewritten into a **trait-based style descriptor** — the
  concrete prose qualities (sentence rhythm, diction register, structural habits)
  rather than the name. Better output, and no imitation-of-a-named-author claim.
  Public-domain authors are allowed by name.
- **Protected-property detection.** A registry of well-known franchise names,
  characters and settings; when a codex entity or prompt matches, the writer gets
  a non-blocking warning distinguishing *fan fiction* (fine for private use,
  legally fraught to sell) from *publication risk*. Warn, explain, don't block.
- **Regurgitation check.** Generated passages are screened for verbatim overlap
  against any source text the writer has imported as reference, and long
  distinctive n-grams are flagged for the writer to check. Models do sometimes
  emit memorised text; catching it before publication is a real service.
- **Style exemplars are the writer's own prose.** Few-shot examples for the
  `style` role are drawn from scenes the writer wrote, never from third-party
  text. The tool will not ingest a copyrighted novel to imitate it.
- **Provenance export.** Optional per-scene record of which passages were
  AI-drafted, AI-revised or human-written, exportable — increasingly relevant for
  publisher and platform AI-disclosure requirements.

## Presets

Ship editable law packs so nobody starts from an empty list: *Deep Third-Person
Past*, *Present-Tense First Person*, *Epic Fantasy Register*, *Hard SF Rigour*,
*Cozy Mystery*, *Literary Restraint*, *Thriller Pace*, *YA Voice*,
*Clean / Sweet Content*, *Adult / Explicit*. Each is a set of `style`,
`structure` and `content` laws the writer then bends to fit.
