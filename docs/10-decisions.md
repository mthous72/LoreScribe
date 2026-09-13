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
