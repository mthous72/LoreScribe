# Legal compliance — how it's actually achieved

*This is an engineering document about where legal exposure comes from and what the
software does about each source. It is not legal advice. Anything beyond personal,
unpublished use — and especially the day a book goes out — deserves an hour with an
actual lawyer, and this document is written so that hour is productive.*

The project's own premise is "novels of every kind, without them being illegal."
"Compliance" for a personal tool ([D7](10-decisions.md)) breaks into six separate
surfaces, and they need different mechanisms. A prompt instruction saying "don't"
covers almost none of them.

---

## 1. Provider terms — the largest surface, and the most concrete

Every model call is governed by two contracts: **OpenRouter's terms**, and the
**usage policy of whichever upstream provider actually served the request**.
OpenRouter routes to many providers whose policies differ sharply on mature
fiction; violating one gets the account terminated regardless of what the app
intended. Local models are not exempt — Llama, Gemma and most open weights ship
with an Acceptable Use Policy accepted at download.

**Compliance is routing, not prompting.** Content goes only where the governing
policy permits it. Concretely:

- **`provider_policy` registry** — one row per upstream provider: policy URL, the
  highest prose register it permits, violence stance, whether it trains on inputs,
  whether zero-retention is available, and `last_checked`. Seeded conservatively;
  a row older than ~90 days shows a warning until re-verified against the live
  policy, because these change.
- **The register dial consults it.** Setting a project to register 4 with a
  drafting model whose provider permits only 2 produces a warning *before* a token
  is spent, naming the constraint and offering models whose policy permits the
  level. OpenRouter exposes per-model moderation flags; the picker surfaces them.
- **Refusals are reported as refusals**, with the serving provider named
  (`ai_run.status = 'refused'`, `ai_run.served_by`). Never silently degraded, never
  retried against a different provider without saying so.

  This is not hypothetical: it is already how a careful writer works around
  provider limits by hand — draft the non-explicit skeleton on one model, hand off
  the specific gaps that need a higher register to a provider whose policy permits
  it (xAI's Grok is a real example), and never pretend the first model produced
  what the second one did. `provider_policy` and the register-aware routing above
  are that exact practice, automated and made visible rather than manual and
  ad hoc — see the "Fill slot" mode in [doc 06](06-ai-pipeline.md).
- **Hard rule: LoreScribe never attempts to circumvent a provider's safeguards.**
  No jailbreak framing, no "for a novel, so ignore your guidelines," no automated
  rephrasing to slip past a refusal. That is a terms violation on its own, and it
  is the single behaviour most likely to get an account banned. The remedy for a
  refusal is a different provider or a local model — chosen by the writer, visibly.

## 2. The hard floor — enforced structurally, before the call

Three system laws ([doc 04](04-laws-engine.md)) are non-editable. Injecting them
into the prompt is the *weakest* part of enforcing them; the real mechanism is that
**the story graph knows things a prompt filter can't**, and checks them before any
request is built:

- **`entity.maturity`** (`adult | minor | unknown | n_a`), species-independent — a
  two-hundred-year-old elf child is still a minor. If a scene's effective register
  is ≥ 3 and any `pov`/`focus`/`present` character is `minor`, the run is
  **blocked** (`ai_run.status = 'blocked'`) before anything is sent, with the reason
  shown. If any such character is `unknown` at register ≥ 4, the writer is asked to
  set maturity first. This is deterministic, cheap, and not something a model can
  be talked out of.
- **`entity.is_real_person`** — sexual content involving a real identifiable person
  is blocked the same way; a real person appearing in any scene gets a standing
  defamation/right-of-publicity warning (see §5).
- **Operational harm** (working synthesis routes, functional exploit code, weapon
  construction presented as fiction) has no structural signal and relies on the
  provider's own safeguards plus the rubric check. Say so honestly in the UI rather
  than implying the app catches it.

The floor is deliberately broader than the narrowest reading of any single
jurisdiction. Written fiction is treated very differently across the US, UK,
Canada and Australia — some criminalise text alone — and a personal tool has no
business optimising toward the most permissive one. The user's own framing of the
project already puts the line here.

## 3. Copyright — for the day this gets published

Two distinct problems, usually conflated.

**Owning what you wrote.** Under current US Copyright Office guidance (the 2023
registration guidance and the 2025 report on copyrightability), purely
AI-generated text is not protected; human authorship — writing, substantive
revision, selection and arrangement — is, and registration requires disclosing
the AI-generated portions. Publishers and platforms increasingly require the same
disclosure (Amazon KDP has since 2023). **Provenance tracking is the compliance
mechanism**, and it has to be span-level to be useful:

- An `origin` mark in the editor document on every span: `human`, `ai_draft`,
  `ai_revised`, `human_revised_ai`. Set automatically on accept, updated as the
  writer edits (a human edit of ≥ N% of a span promotes it).
- `scene_version.provenance_json` rolls it up in words per origin.
- The **disclosure export** produces exactly what a registration form or platform
  asks for: which passages, what proportion, in what role. Doing this after the
  fact from memory is impossible; doing it from marks is a query.

**Not infringing anyone else.** The `ip` law category covers it:

- "In the style of *living author*" is rewritten into trait-based descriptors
  (sentence rhythm, diction register, structural habits). Public-domain authors are
  allowed by name.
- Protected-property warnings distinguish private fan fiction (fine) from
  publication risk (not fine), and warn rather than block.
- **Regurgitation screening**, stated with its real limits: verbatim-overlap checks
  run against *imported reference material* and against the writer's own prior
  text. There is no corpus of the model's training data to check against, so the
  best available signal for memorised text is a long, unusually specific passage
  the writer doesn't recognise — flag those for a manual look, and don't pretend
  the check is stronger than it is.
- Style exemplars come from the writer's own prose only. The tool will not ingest a
  copyrighted novel to imitate it; imported references are for *consultation*
  ([doc 09 §6](09-libriscribe-review.md)) and never reproduced.

## 4. The code itself

**Referenced projects.** LoreScribe is MIT ([D11](10-decisions.md)). Two
relationships, two rules:

- **LibriScribe (MIT) — derived.** Porting is permitted. MIT's single condition is
  that the copyright and permission notice accompany "copies or substantial
  portions of the Software," so: the notice is reproduced in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), `LICENSE` points to it, and
  every file containing derived code carries the attribution header naming both
  copyright holders. The fork you maintain is treated like any other MIT project:
  it also carries Fernando Guerra's original work under his copyright, and drawing
  a line by authorship is error-prone, so *everything* derived from it is attributed
  to both.
- **novelWriter (GPL-3) — design reference only.** GPL-3 material in an MIT project
  would require the whole project to be distributed under the GPL. Nothing is
  copied or derived; short excerpts appear only in `docs/11`, marked and attributed,
  as fair comment.

[`tools/third_party_overlap.py`](../tools/third_party_overlap.py) enforces both:
`--mit` overlap in a file without the attribution header is a defect, `--gpl`
overlap outside the review documents is a defect. Run it against fresh checkouts
before any release and whenever derived code lands. MIT grants no trademark
rights and none are needed: both names appear only to refer to those projects.
The complete list of everything consulted is [doc 14](14-references.md).

**Dependencies.** The remaining exposure. Irrelevant while the tool is personal and
unpublished — but a licence check in CI costs one config file and prevents a
copyleft dependency from quietly foreclosing the option to release later.
Allowlist: MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, Unlicense, CC0, and public domain
(sqlite-wasm). Anything else fails the build until someone looks at it. The planned
stack is clean: Tiptap, Capacitor, React (MIT); Drizzle, Tesseract.js (Apache-2.0).

**One encryption-export wrinkle, recorded early so it isn't rediscovered.**
`@capacitor-community/sqlite` links SQLCipher into the Android build **even when
no database is encrypted**, and its own README raises the resulting US export
self-classification question. Three things make this a note rather than a
problem: nothing is published ([D7](10-decisions.md)), the encryption is not used
([D12](10-decisions.md)), and the plugin doesn't enter the build until Phase 6.
It becomes live only if the tool is ever distributed — which is precisely the
decision that would reopen half this document anyway.

## 5. Real people

The floor blocks sexual content involving real people. Everything else about real
people in fiction — defamation, false light, right of publicity — is a risk on
*publication*, near-zero in a private manuscript, and entirely dependent on
jurisdiction and facts. The tool's job is to make the exposure visible: an
`is_real_person` entity carries a standing warning in its dossier and in the
pre-export report, listing every scene it appears in. That's the list the lawyer
hour is spent on.

## 6. Data handling

Personal tool, one user, no third-party data — so no controller obligations under
GDPR/CCPA-style regimes. The one real issue is the reverse direction: **the
manuscript leaves the device on every cloud call**, and some upstream providers
retain or train on inputs.

- `provider_account.data_policy` defaults to `no_training` and is sent as a routing
  constraint wherever the provider supports it (OpenRouter can exclude providers
  that may train on inputs). `zero_retention` narrows further; `any` is an explicit
  opt-in.
- `ai_run.served_by` records which upstream provider actually handled each request,
  so "where has my book been sent" is a query, not a guess.
- Reference material carries a `licence_note` — the writer's own record of what
  they're entitled to use, for their own future reference. Never exported, never
  reproduced.
- API keys: Keystore on Android; passphrase-encrypted in IndexedDB on web; never in
  SQLite, never in logs, never in `ai_run`.

---

## What the app can honestly claim

Put this in the settings screen, in roughly these words:

> LoreScribe blocks the categories of content that are illegal to produce
> regardless of context, before any request is sent. Above that line, what you
> write is your decision, and the tool routes it only to providers whose published
> policies permit it — it never tries to get around a provider's rules. It records
> which provider handled every request and which passages were written by you
> versus generated, so you can answer disclosure and rights questions with data
> rather than memory. It does not and cannot guarantee that generated text is free
> of memorised training material, and it is not a substitute for legal advice
> before publication.

## Open items for the lawyer hour

Kept here so they don't get lost:

1. Confirm the maturity rule's threshold (register ≥ 3 blocks; ≥ 4 requires
   maturity set) is conservative enough for the jurisdictions that matter to you.
2. Confirm that span-level provenance meets the disclosure form you'd actually
   file — registration and platform disclosures differ.
3. Whether `licence_note` on imported references should record anything more
   formal than a free-text field.
4. Whether any planned OpenRouter upstream has terms that bite on *fiction
   specifically* rather than on content categories — some do.
