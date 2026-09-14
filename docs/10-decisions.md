# Decision log

Founding choices, with the reasoning, so a later "why is it like this?" has an
answer. Superseding a decision means adding an entry, not editing one.

---

### D1 — React + TypeScript + Capacitor, one codebase
One UI to maintain, ships as an installable PWA and an Android build, and keeps us
in the ecosystem where ProseMirror and the AI SDKs live. Rejected: React Native
(weaker web half, and desktop is the primary writing surface), Flutter (immature
rich-text editing, thinner AI ecosystem).

### D2 — Local-first SQLite; the writer's own API key, called directly
No server to run or pay for, works offline, no account wall, and the manuscript
never leaves the device unless the writer exports it or sends it to a provider.
Sync is not built, but `rev`, soft deletes and `op_log` exist from commit one so an
optional sync layer is a feature rather than a rewrite.

### D3 — Content policy: a hard floor, and the author's own ceiling above it
Three non-editable system laws cover what is actually illegal. Everything else —
dark, violent, explicit, morally ugly fiction — is the author's call, set with a
1–5 register dial over scoped `content` laws. Plus an `ip` category: trait-based
style descriptors instead of named living authors, protected-property warnings,
and regurgitation checks against imported references.

### D4 — Path B: a temporal knowledge graph, not RAG and not agentic retrieval
See [doc 00](00-vision-and-diagnosis.md). Pure RAG can't express reveal-time and
can't guarantee spoiler safety; agentic tool-use multiplies latency and fails on
local models. Graph-first traversal with vector search as a bounded supplement, and
an extraction loop so the graph is harvested from writing rather than typed.

### D5 — LoreScribe succeeds LibriScribe
*Amended by [D25](#d25--the-libriscribe-importer-is-dropped-a-general-bible-intake-replaces-it):
the `.libriscribe.json` importer below was dropped once it was clear it
protected nobody. The succession itself stands.*

Not a sibling. Consequences, all of which are now planned for:
- The `.libriscribe.json` importer is **Phase 1**, not a late nicety. Nothing else
  matters if existing books can't come across.
- There is a **parity bar** — see the checklist in [doc 08](08-roadmap.md). A
  successor that can't do what the thing it replaces did is not a successor.
- LibriScribe goes to maintenance once the bar is met.

One honest note: LibriScribe is published (releases, a Windows installer) and
LoreScribe is not (D7). Succeeding a published tool with an unpublished one means
anyone else using LibriScribe stays on LibriScribe. That's a fine outcome if you're
the primary user — it just isn't a migration for them, and the repo should say so
rather than implying abandonment.

### D6 — Cloud first (OpenRouter), local later
Unchanged from the original plan. Local support stays *designed for* throughout —
the per-section budget allocator, the capability model, grammar-constrained output,
the reasoning allowance and the sanitiser all exist because local models need them
— but the OpenAI-compatible adapter ships in Phase 7. If local becomes primary
later, that's a config change, which was the point.

### D7 — Personal tool, not published
No Play Store, no release pipeline, no onboarding funnel, no support burden. What
this *doesn't* change: the hard content floor (D3) stays, because "novels of every
kind without them being illegal" is the project's own premise, not a distribution
requirement. What it does change is the compliance theatre around it — the age
affirmation and terms acknowledgment gating the register dial exist to protect a
*publisher* from an unknown user. With one known user they're friction, so the dial
is simply a setting.

### D8 — Web PWA + Android, no desktop wrapper
Rejected a Tauri/Electron desktop build. The PWA installs on Windows and covers the
writing surface. Two consequences fall out of this, and both are real — see
[doc 01](01-architecture.md):
- **The PWA needs an HTTPS origin.** GitHub Pages off this repo is the obvious
  answer; the app is just code, the data stays on device.
- **Static hosting can't set COOP/COEP headers**, which the SharedArrayBuffer-based
  OPFS VFS requires. The `opfs-sahpool` VFS avoids cross-origin isolation entirely
  and is the intended path. **Phase 0 spike confirms this before anything is built
  on it** — if it doesn't hold, the fallback is a service-worker COI shim, and if
  that fails too, D8 gets revisited.

### D10 — Ideas only; no code is ported from anywhere
*Superseded by D11 for LibriScribe; still in force for novelWriter (GPL-3).*

Nothing is copied from LibriScribe or novelWriter. Their contribution is what was
*learned* — which failure modes exist, which parameter values work, which order the
steps go in — and every line of LoreScribe is written fresh.

This resolves the licensing tension in [doc 11](11-novelwriter-review.md) outright:
**LoreScribe stays Unlicense**, no MIT attribution to carry, no GPL-3 contamination
to reason about, no per-directory licence split.

The one cost is a real risk, and it is mitigated rather than accepted: ideas held
only as a memory of someone else's code decay fast. So the findings are written up
as **behaviour specifications** in [doc 12](12-algorithms.md), at implementable
fidelity. That document is the implementation reference from here on; the source
repositories are not, and no one needs to open them again.

**The reference policy, made concrete.** "Ideas only" needs a line, so here it is:

| May be taken freely | Only as a marked, attributed quotation in docs 09/11 | Never |
|---|---|---|
| Which problems exist · algorithms and their step order · parameter values that work · observed facts and measurements · data-model concepts · UX patterns | Short excerpts of comments, README text or prompt wording, for commentary | Code · prompt strings used as *our* prompts · UI copy · data tables (stopword lists, substitution maps) · regular expressions · test fixtures · file layouts copied wholesale |

Copyright protects expression, not ideas, so the first column carries no
conditions from anyone's licence. The middle column is fair comment and is in any
case within what MIT permits, but it is confined to the two review documents so
that nothing in a specification or in code ever inherits borrowed wording. The
third column is simply not done. [`tools/third_party_overlap.py`](../tools/third_party_overlap.py)
checks all of this mechanically against the reference checkouts and fails on any
7-word overlap outside the permitted files; [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
reproduces the MIT notice regardless, out of courtesy.

Phase 0b is accordingly an *implementation* phase, not a port. It costs more than
a transliteration would have — roughly a week rather than three days — and buys a
clean licence, TypeScript that reads like the rest of the codebase rather than
transliterated Python, and tests written against specified behaviour instead of
against whatever the original happened to do.

### D11 — MIT licence; porting permitted from permissive sources, with attribution
*Supersedes D10 for LibriScribe. D10 remains in force for novelWriter.*

LoreScribe is MIT-licensed. The Unlicense was going to be trouble: a public-domain
dedication can't cleanly absorb MIT-derived code, and it is legally uneven across
jurisdictions. MIT is also what the LibriScribe fork already uses, so the two
projects can share code in either direction without ceremony.

**What changes.** Code *may* now be ported or adapted from LibriScribe (MIT). The
conditions are MIT's own, and the project adds one of its own for hygiene:

1. Every file containing derived code carries the attribution header in
   [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), naming both copyright
   holders — Fernando Guerra for the original, mthous72 for the fork.
2. The MIT notice is reproduced in `THIRD_PARTY_NOTICES.md` and pointed to from
   `LICENSE`.
3. [`tools/third_party_overlap.py`](../tools/third_party_overlap.py) now runs in two
   modes: overlap with a `--mit` source in a file *without* the header is a defect;
   overlap with a `--gpl` source is a defect anywhere outside the review documents.

**What does not change.** novelWriter is GPL-3. GPL material inside an MIT project
would require the whole project to be distributed under the GPL, so **nothing from
novelWriter may be copied or derived from — ideas only, as before.** The MIT licence
depends on this boundary holding, and the tool enforces it.

**Phase 0b becomes a hybrid.** [Doc 12](12-algorithms.md) is still the specification
and still the thing tests are written against. Where porting a LibriScribe utility
is faster than writing it fresh, port it, attribute it, and make it pass the spec's
tests. Where the spec has moved past the original (the round-trip mojibake map, the
role-weighted seeding), write fresh. The choice is made per file, on engineering
grounds, now that licence is no longer a factor in it.

**References.** Everything consulted for the plan — opened, referred to, or cited
from general knowledge — is listed in [doc 14](14-references.md), with the last
category flagged for verification.

### D9 — Android keeps Capacitor even though nothing ships to a store
A plain PWA on Android would drop Capacitor entirely, which is tempting under D7.
Rejected, for one reason: **browser-managed storage can be evicted.** OPFS and
IndexedDB are subject to eviction under storage pressure, and the thing at risk is
an entire novel. Capacitor's native SQLite writes to app-private storage, which
isn't. Builds get sideloaded; the signing and release pipeline is cut.

The same risk applies to the web build, where it can't be designed away, so it's
mitigated instead:
- call `navigator.storage.persist()` on first project creation and surface the
  answer honestly if it's refused;
- **scheduled automatic backup export is not optional** — with no server and no
  sync, an evicted OPFS database with no recent export is total loss. This moves
  from backlog item C26 into Phase 1.

### D12 — No at-rest database encryption; device security is the boundary
The project database is not encrypted beyond the OS's own protections (device
passcode, FileVault/BitLocker/Android's disk encryption). The API key stays
encrypted regardless ([D2](10-decisions.md), doc 01) — that's a credential, a
different risk class from the manuscript.

The alternative was a passphrase-gated database, unlocked each session. Rejected:
meaningful extra engineering (key derivation, an unlock screen, a recovery story
for a forgotten passphrase with no server to reset it against), a friction cost
paid on every single app open, for a personal tool on the writer's own devices
where the OS already provides this. Revisit if the device-trust assumption ever
changes — a shared or borrowed device, for instance.

### D13 — Android is the primary target; desktop/web is secondary and best-effort
Testing and polish priority go to a recent Android phone (the last ~3 years —
Android 12/API 31 and up). Desktop browser support is assumed Chromium-family
(Chrome/Edge) as the safer bet for the `opfs-sahpool` VFS, but is not the daily
driver being designed for and gets tested opportunistically rather than as a
release gate.

This narrows the Phase 0 spike's required scope: confirming SAHPool and the
multi-tab lock on Chromium is the bar, not a cross-browser matrix. If Safari or
another engine turns out to matter later, that reopens this decision and possibly
[D8](10-decisions.md), not the other way around.

### D14 — The public repo never contains manuscript or story-bible content
LoreScribe's repository is public ([confirmed 2026-09-13](08-roadmap.md)), which
was fine for a design plan and a schema but is a real hazard for the thing the
software actually manages: a writer's unpublished manuscript, which may be
sensitive, explicit, or simply not the writer's to publish yet. Nothing about D7
("personal, not published") extended to the *content* — only to the software not
having a store listing, marketing, or a support burden. The two are easy to
conflate and must not be.

**Rule:** no manuscript, story-bible, or fixture content derived from a real book —
the writer's own or anyone else's — is ever committed to this repository, in any
branch, at any point in its history. This is stricter than "delete it later,"
because a public repo's history is not truly private once pushed, even after a
force-push or a deletion commit — assume anything pushed is permanently public.

**What this means in practice:**
- Real fixture material (a real manuscript used for the Phase 2 decisive test,
  per [doc 08](08-roadmap.md)) lives outside the repository entirely — a local
  directory, referenced by an environment variable or a path the test harness
  reads at run time, never checked in. `.gitignore` is a backstop, not the
  control; the control is that it's never `git add`ed in the first place.
- The synthetic fixture ("The Grey Warden," doc 01) is unaffected — it's invented
  for testing and has no privacy exposure, so it stays in the repo as normal.
- Screenshots, example data, or docs illustrating a feature use invented content,
  never a real project's.
- If this project ever needs a private companion repo for real working data
  (fixtures, personal backups, drafts), that's a separate, private repository —
  never a private branch or a "we'll clean it up before merging" branch of this
  one.

**Recorded because it happened.** A Phase 1 audit found two names drawn from
the real story bible sitting in committed test fixtures — a character's name and
a word from the book's title, used as filler in a sanitiser test and a mention
test. No prose, no plot, nothing that reveals anything; both are ordinary
English words, and the practical exposure is nil. They are corrected, and they
are written down here anyway, because the interesting part is the mechanism: I
had read that bible, needed a plausible name, and one surfaced. Nobody decided
to use it.

That is what this rule is actually defending against — not a careless paste, but
recall. The control is correspondingly unglamorous: fixture names are invented
deliberately, the synthetic cast is the Grey Warden set named in
[doc 01](01-architecture.md), and "it sounded right" is not where a fixture name
comes from. There is no mechanical check available, because building one would
require the very content this rule keeps out of the repository.

### D15 — The mobile editor is not a lightweight capture tool; it's a full peer
Superseded assumption: doc 07 item 25 originally planned phone = capture and
review, desktop = drafting, on the reasoning that thumb-typing 2000 words isn't
worth optimising for. Drafting in practice happens on both surfaces roughly
evenly, so that assumption is wrong and the plan changes with it: the phone
editor gets full investment from **Phase 1**, not a stripped-down mode added
later in Phase 6. Scene editing, the brief inspector, and generation all need to
work well at phone width from the start — this was already a responsive-design
requirement everywhere else in the plan; it now also applies to feature
completeness, not just layout.

### D16 — Desktop gets no dedicated QA matrix; the storage spike still must hold
Two of the round's answers only look contradictory: drafting happens on both
surfaces (D15), but desktop is explicitly *not* a testing target (D13's own
wording). The resolution is a distinction between **where writing happens** and
**where reliability is verified before shipping**:

- Android is the release gate: real-device testing (a physical phone is
  available — see below), every feature checked there before it's considered
  done.
- Desktop/web is used for real drafting, but gets no dedicated cross-browser QA
  pass, no compatibility matrix, and issues specific to it are fixed reactively
  as they turn up rather than pre-empted.

**That distinction cannot extend to the Phase 0 storage spike itself.** The
`opfs-sahpool` VFS and the multi-tab lock ([D8](10-decisions.md),
[doc 11](11-novelwriter-review.md)) are exactly the mechanism protecting real
manuscripts from silent loss, and if desktop drafting is real and regular, that
spike has to be validated against whatever browser actually does the drafting —
skipping it there would be the one silent-failure mode D9/D14 exist to prevent,
not a QA nicety to skip. Absent a named browser, **Chrome is the assumed
validation target** — the same Chromium family D13 already called the safer bet,
and the single most likely daily browser. This is a stated assumption, not a
confirmed fact: if the real daily browser turns out to be something else, say so
before Phase 0's spike runs, since that one validation is load-bearing in a way
the rest of desktop support isn't.

**Android testing is against a real device.** A physical phone is available, so
Phase 6 targets it directly rather than an emulator-first plan — more honest
about real eviction pressure, battery and OS behaviour than an emulator can be.

### D17 — Default spend cap: conservative, visible, adjustable — not a real budget
An OpenRouter account and key are already in hand, with no fixed budget opinion,
so the app picks a conservative default rather than leaving the field blank:
a **$5/day soft warning** and a **$20/day hard stop**, both per-project, both
editable in one tap from the spend meter that triggered them. This is a
runaway-loop guard, not a real budget — it exists so a retry bug or an
oversized batch extraction fails loudly and cheaply instead of quietly running
up a bill, and it is expected to be raised the first time it gets in the way of
legitimate work. Utility roles (summarise, extract, critique, embed) default to
the cheapest capable model on first run, per [doc 06](06-ai-pipeline.md); drafting
does not, since quality there is the whole point.

### D18 — The storage bet is confirmed, and it costs more to reverse than it looked
*Confirms [D8](10-decisions.md); does not supersede it. Detail and sources in
[doc 15 §7](15-phase-0-plan.md).*

D8 chose `opfs-sahpool` on the reasoning that static hosting can't set COOP/COEP.
That reasoning was checked against sqlite.org rather than left as an assumption,
and it holds exactly: the VFS "does not require COOP/COEP HTTP headers," and the
documentation routes clients who can't set those headers to it specifically. Three
things follow that were not obvious when D8 was taken.

**The hosting choice doesn't permit sahpool, it forces it — and forces more
besides.** sahpool pre-opens and holds every access handle in its pool, so it is
*single-connection by construction*. That makes the multi-tab strategy mandatory
rather than a nicety (a Web Lock, a `pauseVfs()` handoff, and a takeover screen
offering *reload* rather than retry, since the failed install is cached for the
life of the page), and it removes WAL's reason to exist on the web. One decision,
three consequences, none of them optional.

**Two drivers is now a decision with a reason, not a default.** The available
simplification — use `@capacitor-community/sqlite` on both platforms — is a trap.
Its web implementation holds the whole database in RAM via sql.js and **a
committed transaction is not durable until the app calls `saveToStore()`**, while
native persists automatically. The same repository code, run both ways, loses data
on exactly one of them. So the `SqlDriver` split stands, and the conformance suite
across both implementations is load-bearing rather than tidy-minded.

**Reversing D8 is dearer than assumed.** The fallback ladder read "COI shim, then
a desktop wrapper." But Tauri v2 has mobile targets and **no confirmable
first-party PWA story**, so falling back to a native shell may mean giving up the
web build rather than keeping both. This is an argument for taking the Phase 0
spike seriously, not for flinching from its answer.

### D19 — WAL is on for the web after all, and three licences joined the allowlist
*Supersedes the WAL guidance in [D18](10-decisions.md) and
[doc 01](01-architecture.md). Recorded because doc 10's own rule is that
superseding means adding an entry, not editing one — and until this was written
D18 read as live guidance contradicting what actually ships.*

**WAL.** D18 reasoned that `opfs-sahpool` is single-connection by construction,
so WAL's concurrency benefit is unavailable and it is not worth enabling. The
premise is right and the conclusion was wrong: WAL's *per-commit* cost benefit
is independent of concurrency, and autosave is one row per commit. Measured,
autosave p95 is 6.1 ms under `delete` and 2.6 ms under `wal`
([doc 16](16-phase-0-spike-report.md) §1). WAL ships, with
`locking_mode=exclusive` applied first on every connection — an ordering that
is not advice: without it a WAL database cannot be reopened at all.

**Three licences.** [Doc 13 §4](13-legal-and-compliance.md) lists the dependency
allowlist as MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, Unlicense, CC0 and public
domain. `tools/check-licences.mjs` also permits **BlueOak-1.0.0, MIT-0 and
Python-2.0**, which were added while getting the check to pass rather than by a
decision. All three are permissive and non-copyleft, so the boundary doc 13
actually cares about — nothing copyleft foreclosing a later release — is intact.
They are named here so the allowlist and the document that describes it agree,
and so the next addition has to be a decision rather than a convenience.

### D20 — Prettier is waived, and formatting is enforced in ESLint instead
*Closes the Gate D2 gap recorded in [doc 15 §4](15-phase-0-plan.md): "Prettier —
dropped silently. Never installed, never waived." The finding was not that
Prettier is missing. It was that nobody decided.*

Gate D2 listed "ESLint, Prettier, `tsc --strict`" as a bundle, without asking
whether a whole-file reformatter suits a codebase that uses layout as
information. It was tried before being waived, so this is measured rather than
assumed: Prettier 3.9 at `printWidth: 100` rewrote **62 files, +2,599 / −906
lines**, and the expansion landed almost entirely on constructs that are compact
on purpose.

- `ARCHIVE_TABLES` in `src/data/archive.ts` is eighteen rows of the same five
  keys, one per line, and reviewing it means scanning a column. Prettier turns
  it into ninety lines and the column disappears.
- Every `try { … } catch { /* going anyway */ }` becomes a three-line block, so
  the comment saying "ignore this" ends up more visually prominent than the code
  it guards. `src/app/DbProvider.tsx` went from 150 lines to 224 this way.
- The carry and borrow loops in `src/domain/sortKey.ts` read as arithmetic when
  each branch is one line and as control flow when each is four.

Against that, Prettier buys freedom from formatting decisions. Worth a lot on a
large team; worth less here, and not worth 2,599 lines of churn through
`git blame` in a repository whose documentation strategy is that the reasoning
lives in the history.

**What the gate actually wanted** is that formatting is machine-checked and never
argued about in review, and *that* is now true, which it was not before this
decision. `@stylistic/eslint-plugin` enforces the properties that genuinely vary
between hands — quotes, semicolons, indentation, trailing commas and whitespace,
final newline, a 110-column limit that comments are not exempt from — and CI
already runs `npm run lint`. Applying it found 99 real violations. Line
*packing* stays with the author.

The honest cost: someone will eventually want to pack a line the reviewer would
not. That is one small argument occasionally, against a permanent loss of the
layouts above. If this repository ever grows past a handful of contributors,
revisit it — the reason recorded here is about size and about layout carrying
meaning, and the first of those can change.

### D21 — The PWA is built, and the service worker never takes over a live page
*Closes a Phase 1 audit finding: [doc 01](01-architecture.md) and
[D7](10-decisions.md)/[D8](10-decisions.md) have said "ships as an installable
PWA" and "works offline" since the first commit, and there was no manifest, no
icons and no service worker. Both statements were false.*

**Built.** `public/manifest.webmanifest` with 192/512 and maskable icons
(`tools/render-icons.mjs` rasterises them from SVG using the Chromium already
present for Playwright, run by hand and the PNGs committed), a generated
`sw.js`, registration in `src/pwa/register.ts`, and `tests/pwa.spec.ts` covering
each claim so neither can go quietly false again. Every URL in the manifest is
relative, so one build serves Pages under `/LoreScribe/` and a Capacitor bundle
under `./`; the Pages workflow now fails if the manifest, the worker or the
icons are not actually served, because a base-path mistake breaks installability
silently and nobody notices until a writer is somewhere without signal.

**Not `vite-plugin-pwa`.** The usual answer, and a reasonable one. Rejected for
two reasons: thirty transitive packages for sixty lines of cache handling in a
repository that licence-audits its tree, and — the deciding one — the update
policy is not the default and is the part that matters here.

**The update waits.** No `skipWaiting` on install, no claim on an update. A
worker that activates immediately swaps the asset bundle under a page that is
already running, and since that page fetches its database worker and lazily
imported chunks by hashed URL — hashes a Pages deploy removes — it can break
mid-sentence. It would also let an old shell run against a database `migrate()`
has already moved forward, which is a real hazard rather than a cosmetic one.
So the new version sits in `waiting` and the UI offers a reload the writer takes
when they are at a stopping point. The first install still claims the page, so
offline works without asking for a reload before it will.

**One bug worth keeping.** The first working version cached everything correctly
and failed offline anyway: the servers send `Vary: Origin` on static assets, the
precache stored those responses against a request with no `Origin` header, and a
module script from the page sends one — so strict `Vary` matching missed *every*
asset while the cache sat there full. `caches.match(..., { ignoreVary: true })`
fixes it, and it is safe precisely because the entries are content-hashed files
whose URL is their whole identity. A PWA that claims offline and fails offline
is worse than one that claims nothing, and only the test caught it.

### D22 — Reorder is pointer events plus a keyboard path, not HTML5 drag-and-drop
*Same shape as [D20](10-decisions.md) and [D21](10-decisions.md): a dependency
considered, measured against what it buys, and the reasoning recorded so the
next person can reverse it on evidence rather than taste.*

**Not the HTML5 drag-and-drop API.** Not "works badly on touch" — `dragstart` is
never dispatched by a touch, so the entire feature would be absent on a phone.
[D15](10-decisions.md) says the phone is a peer rather than a viewer, which makes
a mouse-only reorder not a reorder. Pointer Events cover mouse, touch and pen in
one code path.

**Not dnd-kit**, which is the reasonable pick and genuinely does this better. Two
reasons it is not here: the drop model this tree needs is small — a list of rows
and a line between two of them — and the hard part of an accessible reorder is
the keyboard path, which has to be written either way. Alt+↑/↓ on a focused row
does exactly what a drag does, including across a chapter boundary, because a
tree only reorderable by dragging is a tree some writers cannot reorder at all.

**Drop targets come from `elementFromPoint`, not from measured rectangles.**
Measurements go stale the moment the list scrolls or a row wraps to two lines,
and a stale rectangle drops a scene in the wrong place — a data change, not a
visual glitch.

**The known limitation, recorded rather than discovered later.** There is no
auto-scroll: dragging to the edge of a long manuscript does not scroll it, so a
scene cannot be dragged past the visible list. The keyboard path has no such
limit. Auto-scroll and collision strategies are most of what a library would buy,
so the day a writer needs to drag a scene twenty chapters is the day to take
dnd-kit and delete `src/ui/useReorder.ts`.

**Confirmed on a real phone, 2026-09-14.** The manuscript tree, a drag reorder
by thumb, the editor and the codex were all exercised on Android Chrome against
the deployed Pages origin. This is the decision being tested where it was
placed rather than somewhere convenient: the entire argument for pointer events
over the HTML5 API is that `dragstart` is never dispatched by a touch, and a
desktop pass would have proved nothing about it. [D15](10-decisions.md)'s "the
phone is a peer, not a viewer" is now a result rather than an intention.


### D23 — Migration 001 is frozen, and the suite now runs an old database forward
*Reverses the R8 rule in [doc 15 §2](15-phase-0-plan.md). Recorded because that
rule did not merely turn out to be suboptimal — it shipped a bug that stopped a
real writer opening their book.*

**What happened.** Migration 001 is `db/schema.sql`, imported directly so the
canonical schema and the first migration cannot drift apart. R8 then declared
001 "explicitly mutable until Phase 1 ends", reasoning that there was "no
installed base to protect". Two commits edited it in place under that rule:
`project_lock` became `session_lock`, and the fact views were renamed and
corrected.

**Why it broke.** The premise had already expired. R2b deployed the app to
GitHub Pages and used it on a real Android device *during Phase 0*, so a
database existed in the wild before Phase 1 began. `migrate()` skips every
migration at or below `user_version`; that database was at 2, so both migrations
were skipped and neither edit reached it. It opened, migrated successfully, and
then failed with `no such table: session_lock`.

**Why nothing caught it.** Every test in the repository creates a **fresh**
database. The fresh path and the upgrade path are different code paths, and only
one of them was ever exercised — so the suite could not see this class of
failure at all. That is the finding worth keeping: not a missing test, a missing
path.

**The fix, in two parts.** Migration 003 repairs the drift, written to be
idempotent and to converge from any earlier shape, so it is a no-op on a fresh
database. And `src/db/migrate.test.ts` builds a database from a frozen snapshot
of the Phase 0 schema (`tests/fixtures/schema-phase0.sql`), runs it forward, and
asserts it is **structurally identical** to a fresh one. That test does not need
to know what was edited: any change to `db/schema.sql` without a matching
migration makes the two diverge. Verified by making exactly that mistake on
purpose and watching it fail.

`NodeSqlDriver.open()` also now builds its schema through the real migrator
rather than applying the SQL files by hand. It used to leave `user_version` at 0
while the tables existed — a state no real database is ever in, and a fixture
that does not go through the code which upgrades a writer's database cannot see
bugs in it.

**The rule from here.** A change to `db/schema.sql` needs a matching migration.
Always, and regardless of how early the project feels — "nobody has data yet"
is a claim about the world that stops being true without anyone noticing, and
the moment it does, the cost lands on the one person who trusted the app with a
manuscript.


### D24 — A prose diff is paragraph-first, and a restore never destroys
*Two decisions about `src/text/diff.ts` and `src/data/versionsRepository.ts`,
recorded together because both are choices a reasonable implementation would
make differently.*

**The diff works on paragraphs first, words second.** The obvious thing is to
run the `matchingBlocks` decomposition already in `src/text/similarity.ts` over
the whole scene at word granularity. That produces confetti: with autojunk
deliberately absent ([doc 12 §1.3](12-algorithms.md)), the matcher happily
aligns the "the" in the first line with the "the" in the last, and a writer
looking for what they changed gets a page of single-word matches instead. It is
also the quadratic case — thousands of tokens against thousands.

So a scene is first diffed as a list of paragraphs, which are long and
near-unique and align cleanly, and the word diff runs only *inside* a pair that
survived as a revision of each other. That bounds the cost to one paragraph at a
time and makes the output read the way a writer thinks about their own
revisions. Two paragraphs that share less than half their words are shown whole
rather than paired, because a word diff in which every word is struck through
and every word is new is longer and harder to read than simply showing both.

The alternatives considered and rejected: a line diff (prose has no lines — a
paragraph is one long line that reflows, so a one-word change marks the whole
thing changed), and a character diff ("walked" against "waited" becomes a smear
of single letters).

**Restoring a draft keeps the page first.** `restore` snapshots whatever prose
is currently in the scene, in its own committed transaction, *before* the
overwrite — so the operation is always undoable by restoring the other one, and
the screen offers that by name rather than expecting the writer to work out that
the unnamed draft at the top of the list is their afternoon. The ordering is the
whole of it: snapshot commits, then overwrite, so a failure between them leaves
an extra copy of unchanged text rather than a hole where a scene was.

Two integrations fall out of this and are the parts that could not be got right
by reasoning about either side alone:

- **Keeping a draft flushes the editor first.** Prose lives behind a debounce
  for up to `SAVE_AFTER_MS`, so a snapshot read straight from the table is a
  snapshot missing the sentence the writer just finished — and nothing on screen
  would say so. `DbProvider` grew a public `flushAll` for this; the handover
  path was already using it privately. The comparison flushes on an explicit
  "compare" too, and deliberately does *not* flush on its two-second refresh: a
  diff that forced a write every two seconds would take the debounce away from
  the editor that owns it.
- **Restoring remounts the editor.** The editor owns the document in memory.
  Writing to the scene underneath it would leave the replaced prose on screen,
  and the next autosave would put that prose straight back over the restore —
  losing the restore silently, which is the worst available outcome. So the page
  carries a `reloadToken`, separate from the token every tree write bumps, and a
  restore changes the editor's key. It is in the key rather than just the
  content because restored prose is not an edit of what was there: an undo stack
  that stepped back across it would be undoing keystrokes the writer never made.

Both were verified by deleting them and watching the Playwright suite fail.


### D25 — The LibriScribe importer is dropped; a general bible intake replaces it
*Amends [D5](#d5--lorescribe-succeeds-libriscribe), which made the
`.libriscribe.json` importer Phase 1 and blocking. D5's other consequences
stand; this is one item of its parity bar, not the succession.*

**Why the premise expired.** D5 reasoned that "nothing else matters if existing
books can't come across", and the parity bar exists to protect people using
LibriScribe. D5 itself recorded the honest note that LoreScribe is unpublished,
so anyone else on LibriScribe stays on LibriScribe — which leaves exactly one
person the importer could serve, and they report that they do not use it. A bar
that protects nobody is not a bar. Dropped, with the bundle reader noted as a
day's work if it is ever wanted rather than deleted from the record.

**What replaces it, and why it is not a smaller thing.** A general way to bring
in material a writer already has. Doc 08 already anticipated exactly this case
in Phase 2 — *"a story bible that predates LoreScribe entirely, never run
through LibriScribe"* — so this pulls the deterministic half of that forward
into Phase 1 and leaves the extraction half where it was. The AI lane plugs into
the same review as a second source of suggestions, which is the seam that makes
the Phase 1 work permanent rather than a stopgap.

**"Make no assumptions" is a design rule here, not an aspiration.** It decomposes
into four things that are each checkable:

1. **Parsers know nothing about story.** Every format produces one neutral
   document tree — sections, key/value fields, tables — and nothing else. The
   moment a parser emits an entity, the assumption about what a document *is*
   has been made inside a parser where nobody can see it or change it. A JSON
   file with a `characters` array becomes a table called "characters", not
   characters.
2. **Rules propose and state their reason.** Every suggested destination carries
   the rule that produced it in the writer's own terms, because a suggestion
   nobody can audit is one they accept blindly or reject wholesale, and both
   make the review theatre.
3. **The default is to do nothing.** Anything no rule recognises is `skip` — and
   is still *listed* as skipped, because the only way to notice a missed section
   in a silent list is to notice its absence, which nobody does across two
   hundred rows. The cost of a wrong guess is a codex full of rows to find and
   delete; the cost of a miss is one dropdown.
4. **Nothing is written until it is accepted, and it can be taken back after.**

**Staging needed no new tables.** `proposal_run` / `proposal` were already in the
schema for Phase 5's extraction pass, and `seed_kind` has listed `import` since
it was written. This is the first thing to use them and the first without an
`ai_run_id` — which is why that column is nullable. The extra status values
(`applied`, `failed`, `undone`) are free text with no constraint, and the drift
guard from [D23](#d23--migration-001-is-frozen-and-the-suite-now-runs-an-old-database-forward)
strips comments, so `db/schema.sql` is untouched and no migration was needed.

**Two consequences of the staging design worth keeping:**

- *Proposals refer to things by name, never by a minted id.* A fact about Ilva
  points at the string "Ilva" and is resolved when it is applied. Minting ids at
  staging time would mean rejecting the entity left the fact pointing at a row
  that was never created — a rejection would **corrupt** the import rather than
  shrink it.
- *An applied import can be undone.* Creates are soft-deleted; updates are
  restored from a snapshot captured at the moment the update is applied, because
  by undo time the row has been overwritten and there is nothing left to
  reconstruct it from. A bad mapping writes two hundred rows, and "delete them
  by hand" is not an answer.

**On matching what already exists**, the default is that an exact name or alias
match proposes an *update*: re-importing a corrected file must not give you two
Ilvas, and reconciling duplicates by hand is the job the importer was supposed
to do. An import that omits a field leaves what is there alone.

**Word and zip are parsed by hand**, and both for the same reason rather than to
avoid dependencies. The zip uses `DecompressionStream`, which the browser and
Node both have. The XML uses a small scanner rather than `DOMParser`, which
exists in the browser and not in Node — using it would mean the parser took a
different code path under test than in a writer's browser, the exact arrangement
`NodeSqlDriver`'s header warns about, where the tests cannot see the bugs.


### D26 — The readable export is the import format; there is no private one
*Follows [D25](#d25--the-libriscribe-importer-is-dropped-a-general-bible-intake-replaces-it),
which built the importer this relies on, and sits beside
[D9](#d9--android-keeps-capacitor-even-though-nothing-ships-to-a-store)'s
finding that with no server and evictable storage, an export is not optional.*

There are two exports and they do different jobs. The `.lorescribe` archive is
the **complete** copy — every column, every id, restorable exactly. The Markdown
export is the **readable** one: files a writer can open in any editor, put in a
git repository, or read in ten years when this app is gone.

**The decision is that the readable one has no format of its own.** The bundle is
a folder laid out the way a story bible already is — `characters/ilva.md`,
`manuscript/book-one.md`, `reference/knowledge.md` — and it comes back in through
the importer's existing path rules, the ones written for material a writer typed
by hand. `characters/ilva.md` is recognised as a character because it sits in
`characters/`, **not** because the exporter left a marker in it for itself.

The alternative, and why not: an export carrying its own front matter or a
manifest would round-trip more faithfully and would be quicker to write. It would
also be a format only this app can read, which is a lock-in with a download
button — and it would rot, because nothing else would ever exercise the reader.
Sharing one path means every import bug is an export bug and the round trip is
testable in one assertion: export a project, read the bundle back into an empty
one, and nothing fails to resolve.

**What round-trips is stated, not implied**, in the bundle's own `README.md`:
names, prose, the key/value fields under each entry, and the who-knows-what
table. Ids, ordering keys, revisions, kept drafts and the entity links inside a
scene do not — the archive is for that, and the README says so to whoever opens
the folder rather than leaving them to find out.

Writing the round trip as a test immediately paid for itself: a character who
*suspected* something, with a note about how they heard it, was exported as just
the note and came back as plainly knowing. The belief — the distinction the
`fact_knowledge` column exists for — was lost on the way out and unnoticeable on
the way back in. The cell now leads with the belief word and follows with the
note.

Two smaller consequences worth keeping:

- **Plain text is a separate rendering, not Markdown with the hashes stripped.**
  A line reading `# Arrival` in a `.txt` is a leftover, not a heading.
- **The zip writer and the `.docx` zip reader are one pair.** The docx tests
  build their fixtures with the writer this app ships, so the reader is proved
  against it rather than against a second implementation living in a test file.
  Both are hand-written against `CompressionStream`, which the browser and Node
  both have, rather than carrying a zip library into every page load.


### D27 — D7 cut distribution, not usability; Phase 2.5 exists
*Narrows [D7](#d7--personal-tool-not-published) and adds a phase to
[doc 08](08-roadmap.md). Recorded because the gap was structural rather than an
oversight: no phase in the plan had polish as its deliverable, so nothing was
ever going to catch it.*

**What D7 actually decided.** No Play Store, no release pipeline, no onboarding
funnel, no support burden. [Doc 07 §F](07-suggestions-backlog.md) then listed the
consequences: marketing surfaces, first-run tutorials, beta-reader links,
accounts, support-grade error handling. Every one of those is a **distribution**
surface — work that exists because strangers will arrive without context.

**What it has been doing instead.** Quietly serving as permission to skip
usability for the one person who writes in it. That is a different thing and D7
never claimed it. A tool with one user still has a user, and they are the one
person whose time it wastes.

**Why nothing caught it.** Every phase in doc 08 is a capability phase, and every
screen was built to make a feature provable — the facts page to prove the spoiler
rule reaches real ranks, the import page to prove nothing is written before it is
accepted. Each was designed against its feature and none against any other. The
result passes 491 unit tests and 88 Playwright tests and is still tiring to sit
in front of, because *unpleasant* is not a failing assertion. A quality nothing
tests for needs a phase or it does not happen.

**The narrowing, stated so it can be checked later.** D7 cuts anything whose
audience is a stranger. It does not cut:
- how long the app is comfortable to use in one sitting,
- whether a screen says what it is for when it is empty,
- whether you can get from one part of the app to another,
- whether it can be driven from a keyboard, or read at AA contrast,
- whether the phone is genuinely a writing surface rather than one that functions.

Empty states are the edge case worth naming: they look like onboarding and are
not. Onboarding teaches a stranger a product. An empty state tells the person who
built the thing what this screen is for when they come back to it in March.

**Where it goes.** Phase 2.5, after the compiler and before Laws. Phase 1's
done-when already says *"if this phase isn't pleasant to use, no amount of AI
will save it"* — the only sentence in doc 08 with nothing enforcing it. Phase 2
adds the densest UI in the project, so polishing earlier polishes the wrong
screens and polishing later means Phases 3–5 stack four more surfaces on a layout
nobody has drawn. Its done-when is three checks rather than a feeling: a
mechanical one, a twenty-minute writing session **on the phone** with a written
record of what got in the way, and a re-read of Phase 1's claim answered in
writing with reasons.


### D28 — Drizzle is removed; the repositories always wrote SQL
*Amends [doc 01](01-architecture.md), whose data layer read
`Repositories → Drizzle ORM → SQLite` and described a layer that was not there.*

**What was actually true.** Phase 0 built `src/db/drizzle.ts` and a
`src/db/schema.ts` declaring **2 of the schema's 39 tables**, whose own header
said the remaining 35 *"arrive in Phase 1 alongside the code that uses them"*.
Phase 1 is finished. None arrived. Every repository written in it — manuscript,
codex, facts, search, versions, import, export — goes straight to `SqlDriver`
with SQL, and nothing ever touched the Drizzle handle `DbProvider` was exposing.

Nobody decided against it; it simply never got picked up, because the queries
this app needs are the ones an ORM is worst at. `MATCH` against FTS5 with
`bm25()` column weights, rank recomputation scoped to the rows a move can reach,
and a bulk export join across book/part/chapter/scene are all clearer as SQL and
would have been fought at every step.

**Two things made keeping it worse than removing it**, beyond the unused
dependency:

1. **A second schema definition that can drift.** `db/schema.sql` is the
   canonical artefact and migration 001. A partial TypeScript restatement of it
   is exactly the failure class [D23](#d23--migration-001-is-frozen-and-the-suite-now-runs-an-old-database-forward)
   exists for — and `schema.ts`'s header claimed *"the schema-equivalence test
   proves the two agree"*, which was not true: no such test was ever written.
   A file asserting its own correctness with no test behind it is worse than one
   that says nothing.
2. **It invited a second idiom.** Phase 2 adds a provider layer and more data
   access. A half-adopted ORM sitting in the tree is an invitation to start using
   it there, leaving two ways to read a row and no rule about which.

**Cost of removal, measured:** 55 → 54 production dependencies; the main bundle
935 kB → 868 kB (290 → 272 kB gzip). Two files deleted, seven comments corrected.

**What deliberately stays.** The driver's method names (`run` / `all` / `get` /
`values`) and its positional-array rows were inherited from `sqlite-proxy`'s
contract. They are unchanged, because every repository reads rows positionally
and the async callback shape maps cleanly onto worker `postMessage` — but the
comments now say where the shape came from rather than naming a library that is
gone, and [doc 14](14-references.md) keeps the original findings for the same
reason. A protocol outliving the thing that chose it is fine; a protocol nobody
can explain is not.

**If typed queries are wanted later**, add the dependency back deliberately, for
a place it earns. Carrying one unused for a phase and a half is not the same as
keeping the option open — it is paying for the option while losing the ability to
notice that nothing is using it.

