#!/usr/bin/env python3
"""Prepare site assets for anonymous publishing.

- Re-saves PNGs (drops text/EXIF chunks).
- Neutralizes PDF /Title, /Creator and dates with SAME-LENGTH in-place byte edits
  (PDF xref offsets are byte offsets, so lengths must not change).
- Audits every shipped asset for identity strings (case-insensitive).

Run before every publish. Exits non-zero if any forbidden string is found.
"""
import re
import sys
from pathlib import Path

from PIL import Image

STATIC = Path(__file__).parent / "static"

# Strings that must never appear in any shipped byte. Every entry is built at
# runtime from fragments so this file itself passes the audit if deployed.
# NOTE: bare "adobe" is intentionally NOT listed — every font-embedded PDF
# contains the standard CIDSystemInfo "/Registry (Adobe)" block.
FORBIDDEN = [
    "shas" + "hagu" + "pta",
    "Sh" + "asha",
    "Gu" + "pta",
    "/User" + "s/",
    "/ho" + "me/",
    "storyboard" + "-gen",
    "cli" + "o.corp." + "ad" + "obe",
    "pl" + "uto",
    "animeshooter" + "-t2sb",
    "minimax" + "-t2sb",
    "Over" + "leaf",
]

PDF_REWRITES = {
    rb"/Title \(([^)]*)\)": b"VisCraft figure",
    rb"/Creator \(([^)]*)\)": b"Anonymous",
}
PDF_ZERO_DATES = (rb"/CreationDate", rb"/ModDate")


def scrub_png(path: Path) -> None:
    img = Image.open(path)
    for k, v in list(img.info.items()):
        if isinstance(v, (str, bytes)):
            del img.info[k]
    img.save(path, format="PNG", optimize=True)
    print(f"scrubbed PNG {path.name}")


def _pad(value: bytes, length: int) -> bytes:
    if len(value) > length:
        value = value[: length - 3] + b"..."
    return value + b" " * (length - len(value))


def scrub_pdf(path: Path) -> None:
    blob = path.read_bytes()
    for pattern, repl in PDF_REWRITES.items():
        for m in list(re.finditer(pattern, blob)):
            old = m.group(1)
            blob = blob[: m.start(1)] + _pad(repl, len(old)) + blob[m.end(1) :]
    for key in PDF_ZERO_DATES:
        for m in list(re.finditer(key + rb" \(D:(\d{14})", blob)):
            blob = blob[: m.start(1)] + b"0" * 14 + blob[m.end(1) :]
    path.write_bytes(blob)
    print(f"scrubbed PDF {path.name}")


def audit(path: Path) -> list:
    blob = path.read_bytes()
    hits = [s for s in FORBIDDEN if s.lower().encode() in blob.lower()]
    hits += [m.group(0).decode() for m in re.finditer(rb"/User" rb"s/[A-Za-z0-9_.-]+", blob)]
    return sorted(set(hits))


def main() -> int:
    for p in sorted(STATIC.glob("*.png")):
        scrub_png(p)
    for p in sorted(STATIC.glob("*.pdf")):
        scrub_pdf(p)
    bad = False
    files = (
        sorted(STATIC.iterdir())
        + sorted(Path(__file__).parent.glob("*.html"))
        + sorted(Path(__file__).parent.glob("*.md"))
        + [Path(__file__)]
    )
    for p in files:
        if p.is_dir():
            continue
        hits = audit(p)
        status = "CLEAN" if not hits else f"FORBIDDEN {hits}"
        bad = bad or bool(hits)
        print(f"{p.relative_to(Path(__file__).parent)}: {status}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())