# LoreScribe
AI-assisted novel writing for any genre. Structured lore, world, and character resources linked to the scenes that use them, with chapter/scene and story-arc planning, and user-defined "laws" the AI must follow. Multi-provider — OpenRouter first, local models next. Web app and Android.

## Planning

Design docs live in [`docs/`](docs/) — start with the
[index](docs/README.md), or go straight to the
[vision & diagnosis](docs/00-vision-and-diagnosis.md) and the
[story graph / scene brief compiler](docs/03-story-graph-and-context.md),
which is the core of the system. The draft database schema is
[`db/schema.sql`](db/schema.sql).

**Shape of the thing:** React + TypeScript, local-first SQLite, the writer's own
API key called directly (OpenRouter first, OpenAI-compatible local endpoints
next). Capacitor wraps the same build as an Android APK in Phase 6 — it is not
a dependency yet, and there is no web app manifest or service worker yet
either, so the app is a website rather than an installable offline PWA today.

**Status: Phase 0 complete; Phase 1 next.** The storage bet holds —
`opfs-sahpool` over OPFS runs on a static origin with no COOP/COEP headers, at
150,000 words, with every threshold met, and its file handles survive a
backgrounded tab on a real Android phone. Measurements, and the two assumptions
they overturned, are in [doc 16](docs/16-phase-0-spike-report.md).

Running at <https://mthous72.github.io/LoreScribe/> — `#/diagnostics` runs the
storage spike on whatever device you open it with.

```
npm install
npm run dev        # then open /#/diagnostics to run the storage spike yourself
npm run check      # typecheck, lint, dependency licences
npm test           # the gates
```

LoreScribe is the successor to [LibriScribe](https://github.com/mthous72/libriscribe)
— see the [review](docs/09-libriscribe-review.md) of what carries over and the
[parity bar](docs/08-roadmap.md) it has to clear first. It's built as a personal
tool and isn't distributed; LibriScribe stays where it is for anyone already using
it. Founding decisions are logged in [doc 10](docs/10-decisions.md).

## Acknowledgements

LoreScribe is [MIT-licensed](LICENSE). Two projects shaped its design;
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) states exactly what is taken from
each, [`docs/14`](docs/14-references.md) lists everything consulted, and
[`tools/third_party_overlap.py`](tools/third_party_overlap.py) checks the boundaries.

- **[LibriScribe](https://github.com/mthous72/libriscribe)** (MIT) by Fernando
  Guerra and Lenxys, forked and substantially extended — a hard-won record of what
  goes wrong around a language model at novel length. **Nothing is currently
  derived from it** — every algorithm in [doc 12](docs/12-algorithms.md) was
  written fresh against the specification, and `tools/third_party_overlap.py`
  reports no derived lines. Porting is *permitted* under
  [D11](docs/10-decisions.md) and would carry the attribution header in each
  file; none does, because none needs to. Doc 12 exists because these problems
  were found there first, which is a debt of knowledge rather than of code.
- **[novelWriter](https://github.com/saga-soft/novelWriter)** (GPL-3) by Veronica
  Berglyd Olsen — a decade of care on storage robustness, cross-referencing and
  project structure. **Ideas only; no GPL code is used or derived from**, which is
  what keeps this project MIT.
