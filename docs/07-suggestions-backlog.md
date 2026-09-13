# Suggestions — things worth building beyond the brief

Grouped by how much they pull their weight. The first group is where the product
is won or lost; the last is genuinely optional.

## A. High leverage — strongly recommended

1. **Extraction / review queue.** Already described in
   `03-story-graph-and-context.md`, but it belongs at the top of any priority
   list: it is what makes a structured codex viable instead of homework.
2. **The brief inspector.** A panel showing exactly what the AI will see, with
   token counts per section and per-item include/exclude toggles. No competitor
   does this well. It converts "the AI is being stupid" into "ah, that fact wasn't
   linked" — it makes the system debuggable by its user, and it teaches the writer
   how to get better results.
3. **Continuity checker (batch).** Scan the manuscript against the graph and
   report: contradicted facts, characters acting on knowledge they don't have,
   dead characters on the page, timeline impossibilities, eye/hair/name drift,
   POV violations, aliases used before the reader can connect them. Run it on
   demand and as a pre-export gate.
4. **Repetition and echo detector.** Pure computation, no AI, universally loved:
   overused words per scene and per book, distinctive phrases repeated across
   chapters, sentences starting the same way, character-name density, filter words
   ("she felt", "he noticed"), crutch verbs. Cheap to build, immediately useful.
5. **Setup / payoff ledger.** Unpaid Chekhov's guns, reveals landing before their
   setup, clues planted with no answer. Falls out of the fact model for free.
6. **Snapshots and diff.** Whole-project snapshots, per-scene version diff with
   a proper word-level diff view, and restore. Non-negotiable for trust in a tool
   that rewrites your prose.
7. **Export.** EPUB, DOCX, Markdown, plain text, PDF; plus a full project export
   as a single portable `.lorescribe` archive (JSON + media). Local-first means
   nothing if the data is trapped.
8. **Import.** Plain text/Markdown/DOCX with chapter detection, and — deliberately
   — a Scrivener `.scrivx` and NovelCrafter/Campfire importer. Meeting writers
   where their existing 80k words already live is the difference between a trial
   and a migration.

## B. Strong differentiators

9. **Character interview mode.** Chat with any character, constrained to their
   knowledge as of a chosen scene. Discovers voice, surfaces motivation holes, and
   the answers can be promoted straight into facts.
10. **Style DNA.** Analyse the writer's own accepted prose and derive a measured
    style profile (sentence-length distribution, dialogue ratio, paragraph
    rhythm, vocabulary register, favourite constructions). Use it to seed style
    laws and as few-shot exemplars — the tool learns *your* voice from your book,
    not from a named author.
11. **"What if" branching.** Alternate versions of a scene or a whole arc kept
    side by side, comparable, with one marked canonical. The schema already
    supports it via `scene_version.parent_version_id`.
12. **Pacing analysis.** Scene length distribution, dialogue/narration/interiority
    ratio, tension curve, chapter-ending strength, POV balance. Presented as a
    revision dashboard, not a score.
13. **Series bible.** Cross-book consistency for the shared codex, per-book
    spoiler boundaries, and a "what a new reader knows entering book 3" view.
14. **World calendar & travel-time checks.** Custom calendars, and distances
    between locations so "they reached the capital in two days" can be checked.
15. **Constrained name generator.** Names derived from a `language` entity's
    phonotactics and naming conventions, so your dwarves stop being called Kevin.
16. **Relationship affinity curves.** Plot `entity_relationship.strength` over
    narrative rank — the shape of a romance or a betrayal, visible.

## C. Quality-of-life that writers will ask for within a week

17. Focus/typewriter mode, dark theme, serif/dyslexia-friendly font options,
    configurable line height and measure.
18. Daily word-count goals, streaks, session timers, sprint mode.
19. Global alias-aware find & replace (rename a character everywhere, possessives
    and all, with a preview).
20. Comments and inline annotations, resolvable; a to-do/"fix later" queue.
21. Read-aloud (native Android TTS, Web Speech API) — the single best line-editing
    technique, and nearly free to implement.
22. Corkboard/index-card view with drag reordering.
23. Split view: prose on one side, codex entry or outline on the other.
24. Keyboard-first navigation and a command palette.
25. Mobile-specific: quick-capture (jot an idea into the project inbox), offline
    read-through, voice dictation into a scene. Assume phone = capture and
    review, desktop = drafting; don't try to make thumb-typing 2000 words good.
26. Encrypted local backup + scheduled export to the user's own cloud folder.

## D. Later / optional

27. Map support: upload an image, pin locations, link pins to entities.
28. Beta-reader mode: a read-only share link with inline reaction/comment capture.
29. Collaboration (co-authors, shared codex) — needs the sync server.
30. Image generation for character portraits and scene mood boards.
31. On-device inference for small models.
32. Publishing helpers: query letter, synopsis (one-page and long form), blurb,
    comp-title suggestions, series bible export for an editor.
33. Plugin/skill system so writers can add their own analysis passes.

## E. Deliberately not doing

- **A "write my whole novel" button.** It produces unreadable books and it
  trains the user to disengage from the one activity the product exists to
  support. Generate at scene scale, with the writer in the loop.
- **Hosting the manuscript by default.** Local-first is a feature, a promise and a
  liability shield all at once.
- **Scoring prose 1–10.** Analysis should be diagnostic and specific. Grades are
  demoralising and meaningless.
