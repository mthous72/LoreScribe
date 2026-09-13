# Phase 0 — the executable plan

[Doc 08](08-roadmap.md) says what Phase 0 contains. This says how it is run, in
what order, and — the part that was missing — **what has to be true before it is
allowed to end.**

---

## 1. What could make Phase 0 fail at its job

Phase 0 exists to fail fast. Its job is not to produce an app; it is to find out,
in a week, whether the storage bet in [D8](10-decisions.md) holds, before there
is a codebase sitting on top of it. So the useful question is not "what could go
wrong in the code" but "what could let a wrong answer survive this phase."

| # | Risk | Why it happens | Why *that* matters |
|---|---|---|---|
| **R1** | The `opfs-sahpool` VFS doesn't work on a static host | Pages can't set COOP/COEP, so the SharedArrayBuffer OPFS VFS is out and we're betting on a second VFS | Already named by [D8](10-decisions.md) and already the first spike. *Known, planned for, not the problem.* |
| **R2** | It works at toy scale and fails at novel scale | SAHPool preallocates a **fixed pool of files**; capacity is a configured number, not unbounded | The failure surfaces in month six with a real manuscript in it — precisely the catastrophic case [D9](10-decisions.md) exists to prevent |
| **R2b** | **The handles don't survive backgrounding on Android** | SAHPool holds exclusive sync access handles; Chrome on Android backgrounds tabs aggressively (a call, a notification, an app switch) | If handles are reclaimed on background, the web path on a phone is unusable — and Android is the *primary* target ([D13](10-decisions.md)). This would move Capacitor from Phase 6 into Phase 0 |
| **R3** | Two tabs, one exclusive handle | The VFS takes the handle exclusively; the second tab gets an exception | The writer doesn't read "locked by another tab," they read a storage error — and the reasonable inference is "my novel is corrupted." In a tool you must trust with 80,000 words, the *perception* of data loss is nearly as costly as the fact of it |
| **R4** | The `SqlDriver` abstraction is shaped by the web engine and Capacitor can't fit it | sqlite-wasm-in-a-worker is an async RPC boundary; `@capacitor-community/sqlite` is a different API with different transaction and batch semantics | The second implementation isn't written until Phase 6, by which point there is a migration history and real data. Doc 08's sequencing rule 3 names this exact hazard; Phase 0 currently has no *mechanism* against it |
| **R5** | `PRAGMA journal_mode = WAL` sits at the top of `db/schema.sql` | Written engine-agnostically; it's the right pragma for native SQLite | Browser OPFS VFSes don't implement the shared-memory primitives WAL needs. So it throws, or it silently no-ops — and a durability mode that differs between the two engines is a difference nobody chose (see §3) |
| **R6** | **Phase 0's stated done-when is satisfiable without answering any of R2–R5** | "A project can be created, persisted and reloaded after a refresh" is true of a three-row database, on the main thread, with no lock, no size and no second engine | A gate that a toy can pass does not gate anything |
| **R7** | The week goes to Tailwind, shadcn, CI and Pages config; the spike lands on day six | Scaffolding is legible progress. Spikes are uncomfortable and might say no | Once the scaffold exists, the spike's answer is no longer free to be "no." Sunk cost starts arguing against reopening D8 |
| **R8** | Migration 001 is frozen before the schema has ever met data | 52 tables, 5 views and 2 FTS tables, all designed on paper | We accumulate 002, 003, 004 patching a schema that never shipped to anyone — permanent cost, zero benefit, since there is no installed base to protect |

### The root cause

R1 is the *named* risk and it is already handled. The one that decides whether
Phase 0 does its job is **R6: the exit criteria are a demo, not a measurement.**

Follow it down. Every other live risk survives a Phase 0 that meets its stated
done-when — R2, R2b, R3 and R5 are all invisible to "create a project and
refresh." And R7 and R8 are *consequences* of the same defect: with no hard
numeric bar, scaffolding expands to fill the available week; with no explicit
"provisional until" rule, migration 001 freezes by default. One unfalsifiable
gate produces all three.

That is the thing to fix. Fix it and R2, R2b, R3 and R5 are caught by
construction. R4 needs one extra cheap mechanism. R8 needs one sentence.

## 2. How that gets fixed

Three paths were considered.

**Path A — keep Phase 0 as doc 08 writes it, and do it carefully.** Cheapest,
and it relies on discipline to go past the stated bar. Rejected on the project's
own precedent: [`tools/third_party_overlap.py`](../tools/third_party_overlap.py)
exists because we already decided that a rule we intend to keep is worth less
than a rule a machine checks. The same reasoning applies here and points the
same way.

**Path B — a throwaway spike in a scratch repo, then build the app properly.**
Fastest to an answer and immune to R7, since there's no scaffolding to hide in.
Rejected because the numbers have to be reproducible **on a real Android device
and on the deployed Pages origin** ([D16](10-decisions.md)), not once on a
laptop — and because in month six, when something is slow, a throwaway can't be
re-run to say whether it regressed.

**Path C — a permanent, shipped diagnostics harness with measured thresholds.**
*Chosen.*

- The spike is built as a route in the real app (`/diagnostics`), not a scratch
  project. It stays. On Android it is the only honest way to get numbers off the
  actual device.
- It is driven by a **deterministic synthetic-corpus generator** — seeded PRNG,
  150k words, generated at run time and never committed. This is
  [D14](10-decisions.md)-clean by construction: there is no corpus file to leak,
  because there is no corpus file.
- Phase 0 ends on a committed **spike report with numbers in it**
  (`docs/16-phase-0-spike-report.md`), not on a working demo.
- A **driver conformance suite** exists from day one, even though only one driver
  does. That's the mechanism for R4: Phase 6 becomes "make the second driver pass
  the existing suite" instead of "discover in month six that the abstraction was
  the wrong shape."
- Migration 001 is **explicitly mutable** until Phase 1 ends. That's R8.

The cost is about two days over Path A. It buys an Android gate that is
executable rather than aspirational, a performance baseline to regress against,
and a Phase 6 that is an implementation rather than an excavation.

---

## 3. Four things in the current plan that are wrong or unresolved

Found while working this up. All four are cheap now and expensive later.

**a. `PRAGMA journal_mode = WAL` at the top of `db/schema.sql` (line 11).**
WAL needs SQLite's shared-memory primitives, which browser VFSes generally do
not implement. So on the web this either raises or quietly does nothing, leaving
a journal mode nobody selected. Pragmas are also not schema — they're per-
connection or per-database settings, and they do not belong in a migration file
that is supposed to be replayable on two engines. **Fix:** strip both pragmas out
of `schema.sql` and move them into the driver, set per engine at connection open,
with the *effective* mode read back and reported in the spike report rather than
assumed.

**b. There is no migration bookkeeping table.** The schema has 38 tables and none
of them records which migrations have run. **Fix:** the runner creates
`schema_migration` itself before applying anything, and `PRAGMA user_version` is
carried alongside as a cheap cross-check. Decide this in Gate B, not in the
middle of Phase 1.

**c. `project_lock` has a heartbeat but no defined lease.** The column exists;
the semantics don't. Unspecified, it becomes whatever the first implementation
happened to do.

**Fix, and it's simpler than it looked** — see §7, which settles two things. The
Web Locks spec *guarantees* that a terminated agent's locks are released ("For
each lock lock with agent equal to agent: Release the lock"), so crash recovery
does not need a heartbeat at all. But the API has **no mechanism to tell a holder
that someone else is waiting** — that has to be built on BroadcastChannel. So the
two layers divide like this:

- **Web Locks is the liveness mechanism.** Exclusive lock per project id.
  Crash, kill and tab-close are handled by the spec, for free.
- **`project_lock` is the diagnostic and UI layer**, not the lock. It holds the
  human-readable label the takeover screen needs, and a stale row on open is
  evidence of an unclean shutdown — useful, but not the thing granting access.
- **BroadcastChannel carries the handoff**: tab B asks, tab A flushes and
  releases, tab B acquires. `steal: true` exists as the deadlock escape hatch and
  is *not* ordinary flow control — the spec is explicit that a stolen holder's
  callback keeps running with no exclusivity guarantee, which is exactly the
  situation that corrupts a database.
- Every acquisition carries an `AbortSignal` timeout, and the app never nests
  lock acquisitions, because out-of-order nesting across tabs deadlocks.

**d. "Capacitor initialised" in Phase 0 contradicts the phase's own done-when.**
Doc 08 has Capacitor initialised in Phase 0 and the Capacitor SQLite driver in
Phase 6. But with no driver, a native build in Phase 0 boots to an error — so
"persisted and reloaded on a real Android phone" can only mean **the PWA in
Chrome on the phone**, which is a different storage path from the native one
entirely. **Fix:** say so. Phase 0 validates the *web* path on Android hardware;
Capacitor is not initialised. The one thing Phase 0 owes Phase 6 is that the
build's base path is a switch rather than a constant, so that Pages'
`/LoreScribe/` prefix doesn't have to be unpicked later. That is one line of
config, not a day of setup.

This also sharpens what R2b is testing: Phase 0 measures OPFS in Chrome on
Android, which is the evictable path [D9](10-decisions.md) is worried about —
not the app-private path Capacitor exists to reach.

---

## 4. The gates

Strictly ordered. Each one has an exit condition that can be checked rather than
felt. **Gate A blocks everything**: if it fails, the answer is the fallback
ladder in [D8](10-decisions.md), not Gate B.

### Gate A — the storage spike *(blocking)*

Deliberately ugly. No Tailwind, no shadcn, no router, no component library — a
Vite + TS page with buttons on it, because R7 says every hour spent on the
scaffold before this answer is an hour betting the answer is yes.

| | Work |
|---|---|
| A1 | Minimal Vite + TS app. Enough to load a worker; nothing else |
| A2 | sqlite-wasm in a worker; install `opfs-sahpool`; report which VFS is *actually* in use, the effective journal mode, and the pool capacity |
| A3 | Deterministic corpus generator — seeded PRNG, ~300 scenes / 150k words, plus proportionate graph rows. Generated, never committed |
| A4 | The measurement run (table below) |
| A5 | Multi-tab: observe the real failure mode first, *then* build `project_lock` + Web Locks, the "open in another tab" screen, and takeover |
| A6 | Quota and capacity: `estimate()`, `persist()`, and what actually happens when the pool runs out |
| A7 | Kill-and-reopen: hard-kill the tab mid-write, reopen, check for corruption |
| A8 | Backgrounding (R2b): background the Android tab for 10+ minutes with a call or an app switch, return, and see whether the handles survived |
| A9 | Deploy this much to Pages and re-run A4–A8 on the deployed origin and on the phone |

**Measurements.** Targets are opening bids — the point is that they're written
down before the run, so "it felt fine" isn't an answer. A missed target is either
fixed or recorded as an accepted deviation with a reason.

| Measure | Target | Why this number |
|---|---|---|
| Cold open (worker boot → VFS install → first query) | < 1.5 s | App-launch feel |
| Load one scene + its version list | < 50 ms | Inside the typing-latency budget |
| Autosave write of a scene body | < 30 ms, off the main thread | Must not jank the editor |
| FTS query across 150k words | < 200 ms | Search has to feel instant |
| A scene-brief-shaped query set (~20 queries) | < 500 ms | Phase 2 needs headroom above this |
| Bulk insert throughput | > 5,000 rows/s | Sets whether import and backup-restore are viable |
| Longest main-thread block while typing | < 50 ms | Dropped frames are the thing users feel |
| DB size at 150k words, 5 versions/scene | measured | Feeds capacity planning; no target, just the truth |
| Pool capacity consumed at that size | measured | The R2 answer |
| `persist()` granted? | measured, desktop **and** phone | Heuristic and undocumented since 2020 (§7). The answer decides how hard D9's backup has to work |
| Handles survive 10 min backgrounded | pass | The R2b answer, and the one that can move Capacitor into this phase |
| Survives a hard kill mid-write | pass, no corruption | The durability claim the whole local-first bet rests on |

One sizing note worth having before the run: at 150k words the prose is under a
megabyte, and the largest table in the finished product is likely to be
**`ai_run`, because it stores every compiled brief verbatim** — a few thousand
runs at ~30 KB each outweighs the manuscript by an order of magnitude. Chunk-level
embeddings are second. Neither exists in Phase 0, but the capacity headroom has to
be sized for them, so the report projects forward rather than reporting only what
the corpus generator wrote.

**Exit:** `docs/16-phase-0-spike-report.md` is committed, with real numbers from
three environments — local Chrome, the Pages origin on desktop Chrome, and the
Pages origin on the phone. Every target met or explicitly waived.

**Stop rule:** SAHPool fails → service-worker COI shim → that fails too → D8
reopens and a desktop wrapper is back on the table. Under no circumstances does
Gate B start on a red Gate A.

### Gate B — driver, migrations, schema

| | Work |
|---|---|
| B1 | `SqlDriver` interface; the worker-RPC implementation behind it |
| B2 | **Driver conformance suite** — one spec, runnable against any implementation (R4) |
| B3 | Migration runner + `schema_migration`; `db/schema.sql` becomes migration 001, minus the pragmas (§3a) |
| B4 | Pragmas moved into the driver, per engine, read back and asserted |
| B5 | Drizzle wired over the driver; generated types |

**Exit:** the conformance suite is green, and migrating an empty database to 001
produces a schema whose `sqlite_master` dump matches the one `db/schema.sql`
produces directly. That check is the one that catches a migration runner quietly
dropping a trigger or a view.

### Gate C — skeleton, repository, `op_log`

| | Work |
|---|---|
| C1 | React + Tailwind + shadcn/ui; routing; the responsive shell — **phone width is a first-class layout from here, not a later pass** ([D15](10-decisions.md)) |
| C2 | Repository layer, `project` only. Not 38 tables; one, done properly |
| C3 | `op_log` write path and a stable `device_id`. Rows are written; nothing reads them yet ([D2](10-decisions.md)) |
| C4 | `navigator.storage.persist()` on first project creation, with the honest answer shown when it's refused ([D9](10-decisions.md)) |

**Exit:** a project is created and survives a reload, on desktop and on the
phone, via the Pages URL; `op_log` rows are present and correct for every write.

### Gate D — hygiene

| | Work |
|---|---|
| D1 | Vitest; Playwright |
| D2 | ESLint, Prettier, `tsc --strict` |
| D3 | CI: typecheck, lint, unit, `third_party_overlap.py`, dependency-licence allowlist ([doc 13 §4](13-legal-and-compliance.md)) |
| D4 | Pages deploy from CI |

**Exit:** CI is green on a pull request and a merge deploys itself.

---

## 5. Not in Phase 0

Written down so it doesn't creep. No editor. No codex UI. No AI of any kind, no
provider adapter, no credential storage. No Capacitor and no native build (§3d).
No import or export. No repositories beyond `project`. None of doc 12's
algorithms — that is Phase 0b, and it runs alongside Phase 1.

## 6. Standing rules for the phase

- **Nothing from novelWriter, ever** ([D10](10-decisions.md), [D11](10-decisions.md)).
  Porting from LibriScribe is permitted with the attribution header; none of
  Gate A–D is likely to want it.
- **Nothing real gets committed** ([D14](10-decisions.md)). The corpus is
  generated from a seed. There is no fixture file, so there is nothing to leak.
- **Migration 001 stays editable** until Phase 1 ends. There is no installed base
  to protect and the schema has not yet met data. After that it freezes and
  changes arrive as 002 (R8).
- **Commit at each gate**, with the spike report as its own commit, so a red Gate
  A is a readable historical record rather than something to be embarrassed about.

---

## 7. Verified facts this plan now rests on

Checked against primary sources rather than recalled, because a wrong one here
costs a week. Everything below is recorded in [doc 14](14-references.md) at the
appropriate honesty tier; anything that could *not* be verified is named as such.

### The two-driver architecture is vindicated, not merely assumed

There was always a tempting simplification available: use
`@capacitor-community/sqlite` for *both* platforms and have one driver instead of
two. It is a trap, and now there's a reason on file rather than a preference.

The plugin's **web implementation is sql.js — the whole database in RAM —
serialised to IndexedDB through a `jeep-sqlite` web component**, and a committed
transaction **is not durable until the app explicitly calls `saveToStore()`**.
Native persists automatically; web does not. So the same repository code, written
once and run both ways, silently loses data on exactly one of them. On top of
that, every save re-serialises the entire database, and memory scales with file
size — at the 50–100 MB this project expects (§4), that is an architectural
ceiling rather than a tuning problem.

So: **`@sqlite.org/sqlite-wasm` over OPFS on the web, the Capacitor plugin only
on native**, which is what [doc 01](01-architecture.md) already said. What
changes is that the `SqlDriver` conformance suite (Gate B) is now clearly
load-bearing rather than tidy-minded — the two engines genuinely differ, and the
suite is the thing that keeps the difference from reaching the repository layer.

### Eviction on Chromium is less frightening than D9 assumed

[D9](10-decisions.md) treats browser storage as evictable, and it is — but the
documented conditions are narrower than the worst case that decision was written
against:

- Per-origin quota is **up to 60% of total disk**; IndexedDB, Cache and **OPFS
  all draw on one shared pool**, so OPFS gets no separate budget.
- Eviction happens on **storage pressure** or when all origins exceed a
  browser-wide 80% cap. It is **LRU across origins, all-or-nothing per origin**,
  and it **skips origins in persistent mode**.
- **Chrome does not proactively evict unused origins.** Safari does — script-
  writable storage after 7 days without interaction — which is one more reason
  [D13](10-decisions.md)'s Chromium scoping is doing real work.

None of this makes backup optional; D9's conclusion stands and storage pressure
is genuinely more common on a phone. But the realistic failure mode is a full
device, not idle decay, and a granted `persist()` covers it.

*Granted* is the operative word. Chrome decides by heuristics and never prompts —
site engagement, whether the app is installed or bookmarked, notification
permission — and **the canonical documentation of those heuristics dates from
2020 and could not be confirmed against a current first-party source.** So the
engineering stance is the one that survives being wrong about it: call
`persist()`, record the boolean, show the writer the honest answer, and let
[D9](10-decisions.md)'s scheduled backup carry the case where it's `false`.
Whether it is granted in practice is itself a Gate A measurement, on both
desktop and the phone, rather than an assumption.

Two implementation consequences: **`persist()` is not available in Web Workers**
and must be called from the main thread (`estimate()` is fine in a worker), and
`estimate()`'s figures are padded for privacy, so they are a signal and not an
accounting record.

### Web Locks is a spec guarantee, with one real gap

Baseline since March 2022, works in workers and service workers, scoped
per-origin across every tab. Termination releases held locks *and* drops queued
requests, per spec. The gap is cooperative handoff — there is no way to be told
someone wants your lock — and it is designed in, not an oversight. §3c above is
built around both facts.

### Capacitor, for when Phase 6 arrives

Capacitor 8 (min **API 24**, comfortably under [D13](10-decisions.md)'s API 31
target) still documents "one build, served as a website and wrapped as an APK" as
first-class. Tauri v2 does have mobile targets now, but **no first-party PWA story
could be found either way** — which sharpens [D8](10-decisions.md)'s fallback
ladder: falling back to a native shell may mean giving up the PWA, not keeping
both. Worth knowing before Gate A's stop rule is ever invoked.

Two Phase 6 items found early, both durability-relevant enough to record now:

- **Android Auto Backup can restore a stale database over a live one.** The
  plugin requires `android:allowBackup="false"` plus a `data_extraction_rules.xml`
  excluding the database domain. Skip it and the bug reproduces only on real
  upgrade and device-transfer paths — never in development. This is a
  [D9](10-decisions.md) data-loss vector hiding in a manifest file.
- The plugin **links SQLCipher even for unencrypted databases**, which carries a
  US export self-classification question. Moot under [D7](10-decisions.md) while
  nothing is published, and [D12](10-decisions.md) means we aren't using the
  encryption — but it belongs in [doc 13](13-legal-and-compliance.md) rather than
  being rediscovered later.
- Native storage lands in the app-private databases directory: not quota-evictable
  and not touched by "clear cache", though "clear storage" and uninstall still
  remove it. That is the property [D9](10-decisions.md) keeps Capacitor for, now
  confirmed.
