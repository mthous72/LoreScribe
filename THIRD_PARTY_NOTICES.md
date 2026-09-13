# Third-party notices

LoreScribe is licensed under the MIT License (see `LICENSE`). This file lists the
third-party works it draws on, what it takes from each, and the notices each
requires. The governing rules are decision **D11** in
[`docs/10-decisions.md`](docs/10-decisions.md); the full list of everything
consulted while planning is [`docs/14-references.md`](docs/14-references.md).

Two kinds of relationship appear below, and the distinction matters:

- **Derived** — LoreScribe may contain code ported or adapted from the work. The
  work's licence permits this; its copyright and permission notice is reproduced
  here and **every source file containing derived code carries a header saying
  so**. [`tools/third_party_overlap.py`](tools/third_party_overlap.py) fails the
  build if derived material appears in a file without that header.
- **Design reference only** — ideas, algorithms and observations were learned from
  the work; **no code, text or data is copied or derived from it.** Short excerpts
  may be quoted, marked and attributed, in the review documents (`docs/09`,
  `docs/11`) for commentary. The overlap tool treats any other overlap as a defect.

---

## LibriScribe — *derived*

https://github.com/mthous72/libriscribe (MIT), a fork of
https://github.com/guerra2fernando/libriscribe by Fernando Guerra and Lenxys (MIT).

Reviewed in `docs/09`. LoreScribe may port or adapt code from this project,
principally the self-contained utilities specified in `docs/12`. Files containing
derived code carry the header:

```
// Portions derived from LibriScribe (https://github.com/mthous72/libriscribe),
// MIT License, Copyright (c) 2024 Fernando Guerra, Copyright (c) 2025 mthous72.
// See THIRD_PARTY_NOTICES.md.
```

The notice reproduced as required by the MIT License:

```
MIT License

Copyright (c) 2024 Fernando Guerra (original author)
Copyright (c) 2025 mthous72 (fork maintainer)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Writingway — *design reference only, indirect*

https://github.com/a-omukai/Writingway by a-omukai (MIT).

LibriScribe's README credits Writingway as the inspiration for its semantic
retrieval, imported-reference grounding, OCR and multi-session brainstorming.
LoreScribe adopted the *ideas* of a non-canon reference band and of parallel
brainstorm sessions by way of that review. Nothing from Writingway has been read,
copied or derived from directly; it is acknowledged so the lineage is honest.

## novelWriter — *design reference only*

https://github.com/saga-soft/novelWriter by Veronica Berglyd Olsen and
contributors, **GNU General Public License v3.0 or later**.

Reviewed in `docs/11`. **No code, text or data is copied or derived from
novelWriter, and none may be.** GPL-3 material inside an MIT-licensed project
would require the whole project to be distributed under the GPL; LoreScribe's MIT
licence depends on this boundary holding. Identifiers, constant names and the
`@keyword` reference syntax are named in `docs/11` for commentary. The name
"novelWriter" is used only to refer to that project.

---

*If you believe any material in this repository exceeds what is described above,
please open an issue and it will be removed or properly attributed.*
