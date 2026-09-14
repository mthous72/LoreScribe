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
