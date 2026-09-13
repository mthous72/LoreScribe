# Third-party notices

LoreScribe is released into the public domain (see `LICENSE`). **It incorporates no
code, prompt text, data tables, test fixtures or interface copy from any other
project.** Its design was informed by the projects below; what was taken from each
is knowledge of which problems exist and which solutions work, plus a small number
of short excerpts quoted, attributed and marked as quotations in the design
documents (`docs/09`, `docs/11`) for the purpose of commentary.

The notices below are reproduced out of caution and courtesy. Because no copy or
substantial portion of any of these works is present, none of their licences
impose conditions on LoreScribe; reproducing the notices anyway costs nothing and
removes any room for doubt.

The rules this project follows when referencing other software are in
[`docs/10-decisions.md`](docs/10-decisions.md) (D10) and
[`docs/13-legal-and-compliance.md`](docs/13-legal-and-compliance.md) §4, and are
checked mechanically by [`tools/third_party_overlap.py`](tools/third_party_overlap.py).

---

## LibriScribe

https://github.com/mthous72/libriscribe — a fork of
https://github.com/guerra2fernando/libriscribe by Fernando Guerra and Lenxys.

Relationship to LoreScribe: design reference only. Reviewed in `docs/09`. No code
incorporated. Short excerpts of comments, prompt strings and the README are quoted
there, marked and attributed, for commentary.

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

## Writingway

https://github.com/a-omukai/Writingway by a-omukai, MIT licence.

Relationship to LoreScribe: indirect. LibriScribe's README credits Writingway as the
inspiration for its semantic retrieval, imported-reference grounding, OCR and
multi-session brainstorming; LoreScribe adopted the *ideas* of imported reference
material as a non-canon band and of parallel brainstorm sessions by way of that
review. Nothing from Writingway has been read, copied or derived from directly. It
is acknowledged here so the lineage of those ideas is stated honestly.

## novelWriter

https://github.com/saga-soft/novelWriter by Veronica Berglyd Olsen and
contributors, GNU General Public License v3.0 or later.

Relationship to LoreScribe: design reference only. Reviewed in `docs/11`. **No
code, text or data is copied or derived from novelWriter**, and no GPL-licensed
material is present in this repository — which is what keeps LoreScribe's
public-domain dedication intact. A handful of identifiers, constant names and
the `@keyword` reference syntax are named in `docs/11` for the purpose of
commentary. The name "novelWriter" is used only to refer to that project.

---

*If you believe any material in this repository exceeds what is described above,
please open an issue and it will be removed or properly attributed.*
