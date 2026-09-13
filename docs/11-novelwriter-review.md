# Review: what to take from novelWriter

Source: [`saga-soft/novelWriter`](https://github.com/saga-soft/novelWriter) —
Veronica Berglyd Olsen's novelWriter. Python/Qt6 desktop, Linux/Windows/macOS,
82 test files, a 7,000-line changelog, 15 translations. **GPL-3.**

This is a different kind of reference from LibriScribe. LibriScribe is a record of
what goes wrong *around a model*. novelWriter has no AI in it at all — it is a
decade of careful work on everything else: storage robustness, cross-referencing,
project structure, export. It is the best available reference for the half of
LoreScribe that has nothing to do with models, and it's largely silent on the half
that does.

Less to take than from LibriScribe, but two of the findings are things the current
plan would have shipped as bugs.

---

## Adopt

### 1. References are role-typed, not flat
novelWriter's meta syntax distinguishes what a character *is* to a scene:

```
@pov:     the point-of-view character
@focus:   the focal character — the scene is about them, but not through them
@char:    present in the scene
@mention: referred to, but not on stage
```

plus `@plot`, `@location`, `@object`, `@entity`, `@time`, `@story`.

The LoreScribe `mention` table conflates all of these into "entity appears in
scene." That's a real loss, and it bites exactly where the product lives: the
Scene Brief Compiler currently sizes dossiers by `entity.importance`, which is a
property of the *book*. Presence role is a property of *this scene*, and it's the
better signal. A protagonist named once in passing does not need a full dossier in
a scene they aren't in; the POV character always does.

**Action:** `mention.role` — `pov | focus | present | mentioned`. The compiler
seeds from `pov`/`focus`/`present` and admits `mentioned` entities at summary
level only. Cheap change, immediate payoff.

What *not* to copy is the manual half: novelWriter requires the writer to type
`@char: Jane` at the head of each scene. Alias auto-linking with an optional `@`
insert is less work and the plan is already ahead there. Take the taxonomy, not
the data entry.

### 2. Derived data is a rebuildable cache with a revision — never the source of truth
novelWriter's index (headings, tags, references, counts) is cached as JSON,
carries a revision number compared against the project file's on load, and is
**fully rebuilt from the documents** on mismatch or corruption. The documents are
the truth; the index is an optimisation.

LoreScribe has four kinds of derived data — `mention`, `scene_fts`, `embedding`,
and `scene.global_rank` — sitting in the same database as the source of truth,
with **no rebuild path and no staleness detection**. If alias matching has a bug,
or aliases change, or an import half-succeeds, there is currently no way to say
"throw the index away and recompute it." That's a gap, and it's the kind that only
shows up once there's a book in the database worth not losing.

**Action:** mark derived tables explicitly, add an `index_state` row carrying a
schema/algorithm revision per derived kind, bump it when the algorithm changes, and
ship a rebuild path from Phase 1. "Rebuild index" should be a button, not a
support incident.

### 3. Concurrent access will break the web build, and the plan didn't notice
novelWriter takes a lock file recording `lockedBy`, and refuses to open a project
already open elsewhere.

The LoreScribe equivalent is not hypothetical: **the `opfs-sahpool` VFS acquires
exclusive sync access handles**, so a second tab of the same PWA opening the same
project fails to acquire them. Two tabs is not an exotic case — it's what happens
when someone middle-clicks a link or restores a session. As planned, the second tab
dies with an opaque storage error.

**Action:** a single-writer lock — Web Locks API plus a `project_lock` row with a
heartbeat and a device label — and a real "this project is open in another tab"
screen offering takeover. Add it to the Phase 0 spike alongside the SAHPool test,
since both concern the same VFS.

### 4. The backup archive should be self-describing, versioned and recoverable
Three habits, all pointing the same way:

- **Every document carries its own metadata header** — name, parent, handle, class,
  layout, content hash, created/updated dates — so the project tree is
  reconstructible from content alone if the project file is lost.
- **Orphan recovery on open**: a file present on disk but absent from the tree is
  *recovered into the project*, not ignored and not deleted.
- **The project format is versioned with an explicit migration ladder**
  (`FILE_VERSION = "1.6"`, `HEX_VERSION = 0x0106`, with `if version < HEX_VERSION`
  upgrade branches).

LoreScribe has numbered SQL migrations for the live database, but the
`.lorescribe` **export archive has no version field and no migration story** — and
under [D9](10-decisions.md) that archive is the only thing standing between a
scheduled eviction and total loss. A backup you can't open in twelve months is not
a backup.

**Action:** version the archive format; make each scene entry self-describing
(ids, parents, ranks, content hash, dates) so a damaged archive can be partially
recovered rather than wholly rejected; and make the importer salvage what it can
and report what it couldn't, rather than refusing the file.

### 5. Named, saved build profiles instead of one-shot export
Export is a saved configuration, not a menu item: filters (include novel / notes /
inactive), per-heading-level formatting and page breaks, which text to include
(body, synopsis, comments, keywords), and format options — all persisted under a
name. "Manuscript for an agent", "Draft for beta readers", "Everything including my
notes" become three saved profiles rather than three rounds of checkbox-hunting.
Strictly better than doc 07's flat list of formats, and cheap.

### 6. Word counting is an algorithm, not `text.split(" ").length`
`preProcessText` strips formatting codes and shortcodes, treats en and em dashes as
word separators, skips meta lines, and handles block-quote markers before counting
paragraphs, words and characters. Mundane — and if LoreScribe's counts disagree
with what a writer sees in Word or Scrivener, they will distrust the tool's numbers
generally, including the ones that matter. Specify it, test it against reference
files, and count the same way everywhere (goals, stats, budget estimates).

### 7. Don't log junk writing sessions
The session log skips any session under five minutes that changed no words. Small,
but it's the difference between session stats that mean something and a graph full
of noise from opening the app to check a name.

---

## Considered, not adopting

- **Plain files on disk as primary storage.** Right for novelWriter's goals —
  human-readable, version-controllable, survives the application — and wrong for
  LoreScribe's. The temporal graph needs joins, views and FTS across facts,
  mentions and scenes; files plus a rebuilt index means writing a query engine.
  What *is* worth taking is the underlying value — robustness through
  reconstructibility — which item 4 delivers through the archive instead.
- **Synopsis stored in the document as a `%Synopsis:` comment** rather than a
  separate field. Genuinely better for robustness (a summary can never orphan from
  its scene) and worse for querying, which LoreScribe needs constantly. Keeping
  `scene.summary` as a column — but the *export* should inline it, so the archive
  keeps the property the column gives up.
- **Manual `@tag` entry.** See item 1.
- **i18n, code signing, three-OS packaging.** All cut by [D7/D8](10-decisions.md).

## Nothing to take here

No AI, no provider handling, no context assembly, no model-reliability work —
that's what LibriScribe was for, and the two references barely overlap. novelWriter
also has no notion of reveal-time or knowledge state; its cross-referencing is
spatial (what appears where), not temporal (what is true or known when), so the
core thesis in [doc 00](00-vision-and-diagnosis.md) is untouched by it.

---

## Licensing — a real constraint on Phase 0b

Worth stating plainly, because the roadmap currently says "port ~1k lines" and
that phrase has different consequences per source:

| Project | Licence | What that permits |
|---|---|---|
| novelWriter | **GPL-3** | **Ideas only. Do not copy code.** Copying would force LoreScribe to GPL-3. Everything in this document is a design observation; all of it is to be written fresh. |
| LibriScribe | **MIT** — Fernando Guerra (original), mthous72 (fork) | Reuse permitted, but the copyright and permission notice must be retained. |
| LoreScribe | **Unlicense** (public domain) | "No conditions whatsoever" — which is in direct tension with shipping MIT-derived files inside it. |

The Phase 0b ports are fine in substance — `repetition_guard`, `prose_sanitizer`,
`structured_output`, `gap_finder`, `impact` and `stats_service` are all the fork's
own additions (the B-numbered features), so they're your copyright to relicense.
But they live in an MIT repo alongside Guerra's original work, so it's worth being
deliberate rather than assuming. Three clean options:

1. **Relicense LoreScribe MIT** and carry attribution for anything derived. Simplest,
   and it removes the tension permanently. *Recommended.*
2. **Keep Unlicense, isolate the ports** in a directory with their own MIT header
   preserving both copyright lines. Per-directory licensing is normal.
3. **Re-implement from the documented behaviour** rather than the source. Doc 09
   describes each algorithm in enough detail to do this, and the TypeScript port is
   a rewrite anyway — but it's more work for no benefit if you take option 1.

Either way: **nothing from novelWriter gets copied**, only learned from. Its
contribution guide also asks that no AI-generated content be submitted to it, which
is worth respecting in the other direction too — there's no reason for this project
to send anything upstream.
