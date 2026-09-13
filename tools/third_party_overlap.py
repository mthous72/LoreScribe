#!/usr/bin/env python3
"""Check this repository for verbatim overlap with third-party reference projects.

Two kinds of reference project, two rules (docs/10, D11):

  --mit DIR   A permissively-licensed project we MAY port from. Overlap is allowed
              in a file only if that file carries the attribution header (see
              THIRD_PARTY_NOTICES.md). Overlap without the header is a defect.

  --gpl DIR   A copyleft project we may NOT port from. Any overlap outside the
              review documents is a defect, header or not -- GPL material in an
              MIT project would relicense the whole project.

Short quoted excerpts are always permitted in docs/09, docs/11 and the notices
file, where they are marked and attributed for commentary.

Usage:
    python3 tools/third_party_overlap.py --mit ~/mthous72/libriscribe --gpl ~/saga-soft/novelwriter

Exit status 1 on any defect. Reference checkouts are never committed.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

N = 7
QUOTATION_FILES = {"docs/09-libriscribe-review.md", "docs/11-novelwriter-review.md", "THIRD_PARTY_NOTICES.md"}
ATTRIBUTION_MARKER = "Portions derived from LibriScribe"
ALLOW_SUBSTRINGS = ["github.com/", "veronica berglyd olsen", "fernando guerra", "mit license",
                    "gnu general public license", "flesch", "permission is hereby granted", "the software is provided",
                    "copyright (c)"]
SCAN_EXT = (".md", ".sql", ".ts", ".tsx", ".js", ".py", ".json", ".yml", ".yaml", ".txt")
REF_EXT = (".py", ".md", ".tsx", ".ts", ".js", ".txt", ".yml", ".yaml", ".json", ".toml")
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "__pycache__"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def windows(text: str) -> set[str]:
    w = norm(text).split()
    return {" ".join(w[i:i + N]) for i in range(len(w) - N + 1)}


def walk(root: str, exts):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            if f.endswith(exts):
                yield os.path.join(dp, f)


def build_index(roots, kind):
    index = {}
    for ref in roots:
        label = os.path.basename(os.path.normpath(ref))
        for p in walk(ref, REF_EXT):
            try:
                text = open(p, errors="ignore").read()
            except OSError:
                continue
            rel = f"{label}/{os.path.relpath(p, ref)}"
            for g in windows(text):
                index.setdefault(g, (kind, rel))
    return index


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mit", action="append", default=[], help="permissive reference project (port allowed with attribution)")
    ap.add_argument("--gpl", action="append", default=[], help="copyleft reference project (no porting)")
    a = ap.parse_args()
    if not a.mit and not a.gpl:
        ap.print_help()
        return 2
    index = build_index(a.gpl, "gpl")          # GPL first so it wins ties
    index.update({k: v for k, v in build_index(a.mit, "mit").items() if k not in index})
    print(f"indexed {len(index):,} {N}-word windows ({len(a.mit)} permissive, {len(a.gpl)} copyleft)")

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    defects = quoted = attributed = 0
    for p in walk(repo, SCAN_EXT):
        rel = os.path.relpath(p, repo)
        if rel.startswith("tools/") or rel == "LICENSE":
            continue
        try:
            content = open(p, errors="ignore").read()
        except OSError:
            continue
        has_header = ATTRIBUTION_MARKER in content
        for i, line in enumerate(content.splitlines(), 1):
            low = line.lower()
            if any(s in low for s in ALLOW_SUBSTRINGS):
                continue
            hit = next((g for g in windows(line) if g in index), None)
            if not hit:
                continue
            kind, src = index[hit]
            if rel in QUOTATION_FILES:
                quoted += 1
                continue
            if kind == "mit" and has_header:
                attributed += 1
                continue
            defects += 1
            why = "GPL material -- may not be ported" if kind == "gpl" else "derived code without attribution header"
            print(f"DEFECT {rel}:{i}  <- {src}  ({why})\n       {line.strip()[:120]}")
    print(f"\n{quoted} quoted line(s) in review docs; {attributed} attributed derived line(s); {defects} defect(s).")
    return 1 if defects else 0


if __name__ == "__main__":
    sys.exit(main())
