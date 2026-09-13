# References

Everything consulted while producing this plan, in three honesty tiers: what was
actually opened and read, what was referred to but not opened, and what was cited
from general knowledge and therefore **needs verifying before anyone relies on
it**. Licence relationships are in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Accessed and read (2026-09-13)

| Work | What was read | Pinned at |
|---|---|---|
| **LibriScribe** — https://github.com/mthous72/libriscribe (MIT) | README; `services/context_builder.py`, `milestone_verifier.py`, `thread_tracker.py`, `char_state.py`, `connections.py`, `impact.py`, `lore_digest.py`, `gap_finder.py` (head), `sandbox.py` (head), `stats_service.py` (head); `utils/repetition_guard.py`, `prose_sanitizer.py`, `prose_steering.py`, `model_routing.py`, `structured_output.py`, `cost_tracker.py`, `style_register.py`, `llm_client.py` (reasoning-budget sections); `prompts/README.md`; test and frontend file listings; `LICENSE` | commit `51d4ba9` (2026-07-13) |
| **novelWriter** — https://github.com/saga-soft/novelWriter (GPL-3) | README; `core/index.py` and `indexdata.py` (heads), `core/document.py` (write path), `core/storage.py` (head), `core/sessions.py`, `core/projectxml.py` (version handling), `text/counting.py`, `manuscript/buildsettings.py` (keys), `constants.py` and `enum.py` (keyword and class constants); directory layout; test listing; `LICENSE.md` | commit `7fed728` (2026-09-09) |

## Verified against primary sources (2026-09-13, for [doc 15](15-phase-0-plan.md))

Everything Phase 0's storage design rests on was moved out of the
general-knowledge tier below and checked. Where a claim could **not** be
confirmed it is marked as such here rather than quietly promoted — that list is
as useful as the verified one.

| Source | What it settled |
|---|---|
| [SQLite WASM — Persistent Storage Options](https://sqlite.org/wasm/doc/trunk/persistence.md) | `opfs-sahpool` needs no COOP/COEP and is the documented choice for hosts that can't set headers; it is single-connection by construction; pool capacity, sizing rule and the `pauseVfs()`/`unpauseVfs()` handoff; WAL *is* possible since 3.47 via `locking_mode=exclusive`, with little benefit on sahpool |
| [sqlite-wasm README](https://github.com/sqlite/sqlite-wasm) · [Worker1 API](https://sqlite.org/wasm/doc/trunk/api-worker1.md) | `sqlite3Worker1Promiser` deprecated 2026-04-15 and "actively discouraged"; required `optimizeDeps.exclude`; the package's own demo can't be hosted on Pages |
| [MDN — `createSyncAccessHandle()`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle) | Dedicated workers only; the handle takes an exclusive per-file lock that spans tabs |
| [SQLite PRAGMA reference](https://sqlite.org/pragma.html#pragma_user_version) | `user_version` is an uninterpreted header integer — sound as a migration source of truth |
| [Drizzle — proxy driver](https://orm.drizzle.team/docs/sqlite/connect-drizzle-proxy) · [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations) | No sqlite-wasm entry exists; `sqlite-proxy` is the path; the callback returns **positional arrays**, not row objects; the proxy migrator is Node-only |
| [Vite — static deploy](https://vite.dev/guide/static-deploy) · [`base`](https://vite.dev/config/shared-options) · [Vite 8 announcement](https://vite.dev/blog/announcing-vite8) | Pages `base` form; Vite 8 switched to Rolldown days ago — hence pinning 7 |
| [MDN — Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | 60%-of-disk per origin over a pool shared with IndexedDB and Cache; eviction is LRU, all-or-nothing per origin, and skips persisted origins; Chrome doesn't proactively evict idle origins |
| [W3C Web Locks](https://w3c.github.io/web-locks/) · [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) | Per-origin across tabs and workers; termination releases held locks and drops queued requests, per spec; no cooperative-handoff notification exists; `steal` semantics |
| [Capacitor support policy](https://capacitorjs.com/docs/main/reference/support-policy) · [PWA support](https://capacitorjs.com/docs/web/progressive-web-apps) | v8, min API 24 — comfortably under [D13](10-decisions.md)'s API 31 target; one build serving both web and native remains first-class |
| [`@capacitor-community/sqlite` — Web usage](https://github.com/capacitor-community/sqlite/blob/master/docs/Web-Usage.md) · [transactions](https://github.com/capacitor-community/sqlite/blob/master/docs/SQLiteTransaction.md) · [API](https://github.com/capacitor-community/sqlite/blob/master/docs/API.md) | Its web implementation is sql.js in RAM with an explicit `saveToStore()` for durability — which is why we don't use it on the web; Android is WAL2 by default; app-private storage is not quota-evictable; Auto Backup must be disabled in the manifest |

**Checked and *not* confirmed** — recorded so nobody treats them as settled:
current (2026) Chrome `persist()` heuristics, whose canonical write-up dates from
2020; any per-file size limit for `opfs-sahpool`; the exact `DOMException.name`
for the multi-tab collision across browsers; official endorsement of the
`404.html` SPA-fallback convention on Pages; Vite 8 / Rolldown interaction with
sqlite-wasm, which nobody has exercised yet; the precise failure mode of
`journal_mode=WAL` without `locking_mode=exclusive`; any published performance-
pragma set for sqlite-wasm; and whether Tauri v2 supports a PWA target.

## Referred to, not opened

- **LibriScribe (original)** — https://github.com/guerra2fernando/libriscribe by
  Fernando Guerra and Lenxys. Known through the fork's README and `LICENSE`.
- **Writingway** — https://github.com/a-omukai/Writingway by a-omukai (MIT).
  Known through LibriScribe's attribution.

## Cited from general knowledge — verify before relying

None of the following was fetched during planning. The claims are believed
accurate as of the model's training but must be checked against the live
source, **especially the legal and policy items**, which change.

**Legal and policy** (`docs/13`)
- US Copyright Office, *Copyright Registration Guidance: Works Containing Material
  Generated by Artificial Intelligence* (March 2023), and *Copyright and Artificial
  Intelligence, Part 2: Copyrightability* (January 2025) — basis for the
  provenance/disclosure design.
- Amazon KDP content guidelines requiring disclosure of AI-generated content
  (from September 2023).
- OpenRouter terms of service, privacy policy, per-model moderation flags, and
  provider-routing preferences including exclusion of providers that may train on
  inputs.
- Usage/acceptable-use policies of OpenRouter's upstream providers, and the
  acceptable-use policies attached to open-weight model licences (e.g. Llama,
  Gemma).
- General shape of written-fiction content law in the US, UK, Canada and
  Australia — cited only to justify a floor broader than any single jurisdiction,
  not as a statement of any jurisdiction's law.

**Platform and browser** (`docs/01`, `docs/10`)

Most of what was here has **moved up into the verified section above** — the
sqlite-wasm VFSes, Web Locks, storage eviction and `persist()`, Capacitor and its
SQLite plugin, Drizzle, Vite, and Pages' inability to set response headers. What
remains unverified:

- OpenRouter's CORS support for direct browser calls; Ollama `OLLAMA_ORIGINS`,
  LM Studio's CORS setting, llama.cpp server `--api-cors`. **Verify before
  Phase 2**, which is the first phase that calls a provider.
- Android Keystore via a secure-storage plugin; Tiptap/ProseMirror; Tesseract.js.

**Models and inference** (`docs/06`, `docs/12`)
- llama.cpp's compilation of JSON-schema `response_format` into GBNF grammars;
  OpenAI strict-mode schema constraints; reasoning-token reporting fields.
- LexoRank-style fractional ordering.
- Flesch Reading Ease and Flesch–Kincaid grade formulae (published, public).

**Story structure** (`docs/05`)
- Three-Act, Save the Cat, Hero's Journey, Story Circle, Seven-Point, Freytag,
  Kishōtenketsu, Fichtean Curve, Romancing the Beat, the Snowflake Method — named
  as templates; each is a published framework, some under trademark or in books
  still in copyright. Template *names* and beat *positions* are usable; the
  authors' descriptive text is not to be reproduced.
