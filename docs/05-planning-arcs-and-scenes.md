# Story Arc, Chapter & Scene Planning

## Multiple arcs, not one outline

A novel is several overlapping shapes running at once. Modelling only "the
outline" is why plans go stale. LoreScribe tracks parallel **arc tracks**:

- **Main plot** — the external spine.
- **Subplots** — secondary external threads.
- **Character arcs** — one per changing character, scaffolded as
  *want / need / lie / ghost → change*. The lie the character believes and the
  wound that produced it are the two fields that make AI-generated interiority
  stop being generic, so they're structural columns on `arc`, not free notes.
- **Relationship arcs** — between two entities, with an affinity value per beat
  that plots as a curve.
- **Mystery / reveal chains** — ordered setups and payoffs; backed by the fact
  model's `revealed_at`, so the reveal schedule and the spoiler filter are the
  same data.
- **Theme / motif tracks** — where an idea is stated, tested, complicated,
  answered.

## Views

**Arc board (swimlanes).** Chapters along the x-axis, arcs as horizontal lanes,
beats as cards. Drag a beat to a different chapter and everything temporal
follows. Instantly shows a subplot that vanishes for eleven chapters, or an act
two where every lane goes quiet.

**Tension curve.** Per-scene `tension` plotted across the book, optionally per
arc. Flat stretches and unearned spikes are visible in a glance — the kind of
structural read that is nearly impossible from inside the prose.

**Dual timeline.** Two tracks: narrative order (as the reader receives it) and
story-time order (as events occur). Flashbacks, parallel threads and unreliable
chronology become legible, and travel-time impossibilities become checkable.

**Beat/scene matrix.** The `beat_scene` join rendered as a grid. Unrealised beats
(planned, no scene) and orphan scenes (no beat) both jump out. This is the
anti-drift instrument.

**Character presence timeline.** From `mention`: who is on the page, when. A major
character absent for nine chapters is a structural problem that no one notices
while drafting.

**Relationship graph.** Force-directed view of `entity_relationship`, scrubable
by scene rank so you can watch alliances change across the book.

## Structure templates

Templates instantiate beats into an arc; the writer then rewrites them. Support
at minimum: Three-Act, Save the Cat, Hero's Journey, Story Circle, Seven-Point,
Freytag, Kishōtenketsu, Fichtean Curve, Romancing the Beat, and the Snowflake
method as a progressive-expansion *mode* rather than a beat list.

Because beats carry `template_beat_key`, a finished book can also be **checked
against** a template it wasn't written from — "your midpoint lands at 61%, and
nothing reverses there" — which is a genuinely useful revision tool.

## Top-down and bottom-up must both work

Two entry paths into the same data:

- **Top-down:** premise → structure template → act beats → chapter list →
  scene cards → prose. Each level can be AI-assisted with the level above as
  context.
- **Bottom-up:** write scenes as they come, then group into chapters, then
  discover arcs. The extraction loop proposes beats from existing prose so a
  discovery writer gets a plan without having made one.

Most writers do both in the same book. Neither may be privileged in the UI.

## Scene cards

Each scene carries the fields a brief needs and a writer thinks in: purpose, POV
and mode, location, story time, cast, beats served, entering and exiting emotional
value (the scene turn), conflict, outcome (`+`/`-`), tension, target word count.
Filling a scene card *is* filling the generation context — the planning work and
the prompt work are the same work, done once. That equivalence is a core design
rule: **no field exists that only serves the AI, and no prompt asks for something
the plan should already know.**
