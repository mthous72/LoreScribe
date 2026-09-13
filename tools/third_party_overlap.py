#!/usr/bin/env python3
"""Check this repository for verbatim overlap with third-party reference projects.

LoreScribe is ideas-only with respect to the projects it studied (docs/10, D10).
This script makes that checkable: it indexes every N-word window in the reference
checkouts and reports any line in this repository that shares one.

Overlap is EXPECTED in the two review documents (docs/09, docs/11) and in
THIRD_PARTY_NOTICES.md, where short excerpts are quoted deliberately for commentary.
Overlap anywhere else -- a specification, the schema, source code -- is a defect:
either rewrite the line in our own words or, if the overlap is unavoidable (a URL, a
project name, a standard term), add it to ALLOW_SUBSTRINGS below with a reason.

Usage:
    python3 tools/third_party_overlap.py REF_DIR [REF_DIR ...]
    e.g.  python3 tools/third_party_overlap.py ~/mthous72/libriscribe ~/saga-soft/novelwriter

Exit status is 1 if any overlap is found outside the allowed files.
The reference checkouts are not part of this repository and are never committed.
"""
from __future__ import annotations

import os
import re
import sys

N = 7  # words per window; 7 is long enough that accidental overlap is rare

# Files in which quoted excerpts are permitted (commentary, attributed, marked).
QUOTATION_FILES = {
    "docs/09-libriscribe-review.md",
    "docs/11-novelwriter-review.md",
    "THIRD_PARTY_NOTICES.md",
}

# Unavoidable overlaps anywhere: names, URLs, licence boilerplate, standard phrases.
ALLOW_SUBSTRINGS = [
    "github.com/",                       # links to the projects
    "veronica berglyd olsen",            # author attribution
    "fernando guerra",                   # author attribution
    "mit license",                       # licence names
    "gnu general public license",
]

SCAN_EXT = (".md", ".sql", ".ts", ".tsx", ".js", ".py", ".json", ".yml", ".yaml", ".txt")
REF_EXT = (".py", ".md", ".tsx", ".ts", ".js", ".txt", ".yml", ".yaml", ".json", ".toml")
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "__pycache__"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def windows(text: str) -> set[str]:
    w = norm(text).split()
    return {" ".join(w[i:i + N]) for i in range(len(w) - N + 1)}


def walk(root: str, exts: tuple[str, ...]):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            if f.endswith(exts):
                yield os.path.join(dp, f)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    index: dict[str, str] = {}
    for ref in argv:
        label = os.path.basename(os.path.normpath(ref))
        for p in walk(ref, REF_EXT):
            try:
                text = open(p, errors="ignore").read()
            except OSError:
                continue
            rel = f"{label}/{os.path.relpath(p, ref)}"
            for g in windows(text):
                index.setdefault(g, rel)
    print(f"indexed {len(index):,} {N}-word windows from {len(argv)} reference project(s)")

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    defects = 0
    quoted = 0
    for p in walk(repo, SCAN_EXT):
        rel = os.path.relpath(p, repo)
        if rel.startswith("tools/"):
            continue
        for i, line in enumerate(open(p, errors="ignore"), 1):
            lowered = line.lower()
            if any(a in lowered for a in ALLOW_SUBSTRINGS):
                continue
            hit = next((g for g in windows(line) if g in index), None)
            if not hit:
                continue
            if rel in QUOTATION_FILES:
                quoted += 1
                continue
            defects += 1
            print(f"DEFECT {rel}:{i}  <- {index[hit]}\n       {line.strip()[:120]}")
    print(f"\n{quoted} quoted-excerpt line(s) in permitted files; {defects} defect(s) elsewhere.")
    return 1 if defects else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
