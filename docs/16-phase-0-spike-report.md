# Phase 0 — Gate A spike report

The exit condition for Gate A ([doc 15 §4](15-phase-0-plan.md)) is this document
with numbers in it, not a working demo. Reproduce with `npm run spike`, or open
the app and press the button — it is a route in the product, so the same numbers
can be taken from a phone.

**Verdict: the storage bet holds.** `opfs-sahpool` runs on a static origin with
no COOP/COEP headers, at 150,000 words, and every threshold is met. Two of the
plan's assumptions were wrong and are corrected below.

---

## Environments

| # | Environment | Status |
|---|---|---|
| 1 | Local Chromium 153, production build served by `vite preview` | **done — this report** |
| 2 | Deployed Pages origin, desktop Chrome | pending Gate D (CI deploy) |
| 3 | Deployed Pages origin, Android Chrome on a real device | pending — needs the phone ([D16](10-decisions.md)) |

Environment 1 is a headless Chromium in a Linux container. It is a real browser
running the real production build, so the storage semantics are honest; the
*timings* are on container hardware and should be read as an order of magnitude,
not as what a phone will do. Environments 2 and 3 are what close Gate A.

## Corpus

Deterministic, seeded, generated at run time, **never committed** — so there is
no fixture file and [D14](10-decisions.md) holds by construction rather than by
discipline. Seed `20260913`: 300 scenes × 500 words = **150,000 words**, 5
versions per scene, 200 entities, 2,000 facts with both time axes populated,
~15,000 mentions, 30 chapters. 19,539 rows.

## Results — environment 1

| Measure | Result | Target | |
|---|---|---|---|
| Cold open (worker boot → VFS install → first query) | **132 ms** | < 1500 ms | pass |
| Load one scene + its version list | **0.8 ms** p95 | < 50 ms | pass |
| Autosave write of a scene body | **2.6 ms** p95 | < 30 ms | pass |
| FTS query across 150,000 words | **20.4 ms** p95 | < 200 ms | pass |
| Scene-brief-shaped query set (6 queries) | **44 ms** p95 | < 500 ms | pass |
| Bulk insert throughput | **8,157 rows/s** | > 5,000 | pass |
| Longest main-thread frame gap while writing | **16.8 ms** | < 50 ms | pass |
| Survives abrupt kill mid-write | **200/200 rows, `integrity_check: ok`** | no corruption | pass |
| Second tab handled, not left to fail | **refused + recoverable** | handled | pass |
| Database size at 150k words, 5 versions/scene | 12.5 MB (8 KiB pages) | measured | — |
| Pool files consumed | **2 of 8** | measured | — |
| Origin quota | 13 MB used of 962 MB | measured | — |
| `navigator.storage.persist()` | **refused** | measured | — |
| Migration 001 (52 tables, 5 views, 2 FTS) | 167 ms, `user_version` 0 → 1 | informational | — |

SQLite 3.53.4, `@sqlite.org/sqlite-wasm` 3.53.4-build1, Vite 7.3.6.

---

## What the measurements changed

### 1. WAL *is* worth enabling on the web — the plan had this backwards

[Doc 15 §3a](15-phase-0-plan.md) concluded we "probably shouldn't turn WAL on for
the web at all," reasoning that sahpool is single-connection by construction so
WAL's concurrency benefit is unavailable by definition. The premise is correct.
The conclusion doesn't follow, because **WAL's per-commit cost benefit is
independent of concurrency** — and the workload that cares is autosave.

| Autosave write (one row, one commit, ×40) | p50 | p95 |
|---|---|---|
| `journal_mode=delete` | 5.5 ms | 6.1 ms |
| `journal_mode=wal` | 2.1 ms | **2.6 ms** |

Three times better on the write that happens every time the writer stops typing.
Both pass the 30 ms target on container hardware, but a phone has slower storage
and less headroom, and this is the one write in the app that is on the critical
path of the writing experience.

**Decision: WAL for steady-state editing**, set via `locking_mode=exclusive`
first — the ordering is mandatory and is why pragmas live in the driver's
connection-open path rather than in the schema.

### 2. Bulk insert was 10× under target, and journal mode was not the reason

The first run measured **539 rows/s** against a 5,000 target. Prepared-statement
caching — the obvious suspect, since the loader issues ~20,000 statements —
moved it to 565. So statement compilation was not the cost.

Profiling journal mode against transaction count found it:

| rows/s | 1 transaction | 100 transactions |
|---|---|---|
| `delete` | 44,593 | 2,491 |
| `wal` | 45,662 | 9,320 |
| `memory` | 61,444 | 10,878 |

**Within a single transaction the three modes are indistinguishable. The entire
spread is per-commit cost.** The corpus loader was committing 304 times in
`delete` mode, where every commit creates, fsyncs and deletes a rollback journal
file. Spanning the import with one transaction: **8,157 rows/s**, a 15× gain,
with no change to durability.

`memory` is fastest and is **not** a candidate: its rollback journal lives in
RAM, so a crash mid-transaction can corrupt the file. Fast and unsafe is not a
trade this project gets to make with a novel in the database.

**Decision: imports and restores run in one transaction.** Phase 1's
`.libriscribe.json` importer and the backup restore path both inherit this, and
both would have been quietly 15× slower without it.

### 3. The multi-tab failure is more recoverable than the documentation implies

A second tab is refused at **VFS install time**, before any database is opened,
with `NoModificationAllowedError` — the exact exception the research could only
infer from reading source, now confirmed by running it.

But [doc 15 §3c](15-phase-0-plan.md) concluded from sqlite.org's note that a
failed install is cached "so that future calls can return consistent results"
that the takeover screen **must offer reload rather than retry**. Measured, that
is too pessimistic: the cache is scoped to the **JS realm**, and since we spawn a
fresh worker per open attempt, a retry after the holder releases lands in a clean
realm and **succeeds**.

**Decision: the takeover screen can offer retry.** It still offers reload as a
fallback, because a retry is only clean while every open path goes through a new
worker — which is now a property the driver has to keep, and a line in the
conformance suite.

Separately, `pauseVfs()`/`unpauseVfs()` gives a genuine cooperative handoff: tab
A closes its handles and pauses, tab B installs and finds the data intact. That
is the mechanism behind the takeover, and it works.

---

## Open items

- **Environments 2 and 3.** Gate A is not closed until the Pages origin and a
  real Android device are measured. Environment 3 also carries **R2b**, the one
  risk this report cannot touch: whether the exclusive sync access handles
  survive ten minutes of the tab being backgrounded by a call or an app switch.
  If they don't, Capacitor moves forward into Phase 0.
- **`persist()` was refused** in a headless container, which is expected and
  uninformative — there is no engagement history, no install, no bookmark. The
  answer on a real device is the one that matters, and [D9](10-decisions.md)'s
  scheduled backup is what makes a `false` survivable either way.
- **Size projects forward, not backward.** 12.5 MB is the manuscript and graph
  only. The largest table in the finished product is likely to be `ai_run`, which
  stores every compiled brief verbatim — a few thousand runs at ~30 KB each
  outweighs the prose by an order of magnitude — with chunk-level embeddings
  second. Pool capacity is reserved at 8 files against a default of 6; capacity
  is a file count, not bytes, so growth in bytes doesn't threaten it, but temp
  files would, which is why `temp_store=MEMORY` is set.
- **`entity_type` has no seed data.** `entity.type_key` references it and
  `db/schema.sql` ships no rows, so a fresh database cannot hold an entity. The
  corpus seeds seven built-in types to run at all; **Phase 1 needs a real seed
  migration**.
