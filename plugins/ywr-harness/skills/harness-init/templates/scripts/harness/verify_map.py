"""Changed-files -> verify-script reverse index. Backend for the /verify skill.

Reads the generated docs index (single source of truth: spec frontmatter `implements_in`), maps
changed files to owning specs, and prints the verify scripts registered under those specs.
Advisory — no LLM, no network, nothing executed; exits 0 with ONE exception: a git failure
resolving the changed-file scope prints a stdout `scope: FAILED` marker and exits non-zero
(ADR 0041 — an empty advisory output reads as a pass to every consumer).

Usage:
  python verify_map.py                       # working tree vs HEAD + untracked
  python verify_map.py --range main~3..HEAD  # slice range UNIONED with the working tree
  python verify_map.py path/to/file [...]    # explicit files
  python verify_map.py --repo <dir>          # repo root (default: search upward)

--range is a union with the current working tree (tracked changes AND untracked files), so
"verify the slice" always includes the not-yet-committed state; after a clean commit the union
degenerates to the range alone.

Repo-specific values come from `.harness.json` via harness_config — one reader, one validator.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import harness_config as hc

hc.pin_utf8()


def main() -> int:
    ap = argparse.ArgumentParser(description="Map changed files to spec-owned verify scripts.")
    ap.add_argument("--range", dest="rev_range", default=None,
                    help="git rev range (e.g. main~3..HEAD); default: HEAD vs working tree")
    ap.add_argument("--repo", dest="repo", default=None, help="repo root (default: search upward)")
    ap.add_argument("files", nargs="*", help="explicit changed files (skip git diff)")
    args = ap.parse_args()

    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    cfg, warns = hc.load(root)
    for w in warns:
        hc.warn(w)

    try:
        index = json.loads((root / cfg["index"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"{cfg['index']} unreadable ({type(e).__name__}) — run: pwsh docs/build.ps1",
              file=sys.stderr)
        return 0
    specs = index.get("spec", [])

    try:
        files, prov = hc.changed_files(root, args.rev_range, args.files)
    except subprocess.CalledProcessError as e:
        # The one non-zero exit (ADR 0041) — same principle as the gate emitter's scope path:
        # a silent empty output is indistinguishable from "nothing to verify", and the /verify
        # skill would read exactly that.
        print(f"git diff failed: {(e.stderr or '').strip()}", file=sys.stderr)
        hc.say("scope: FAILED — git could not resolve the changed-file scope; NOTHING was "
               "verified. This run must not be read as a pass (ADR 0041).")
        return 1
    hc.print_scope(files, prov)
    if not files:
        hc.say("no changed files — nothing to verify")
        return 0

    late: list[str] = []
    verify_re = hc.compile_re(cfg["script_pattern"], "verify.script_pattern", late)
    scope_re = hc.compile_re(cfg["product_scope"], "verify.product_scope", late)
    for w in late:
        hc.warn(w)

    # Collected during composition below and printed at the END of the run. NOT appended to
    # `late`: that list is already drained above, so anything added afterwards would be swallowed
    # — and a swallowed warning about a refused value looks exactly like a good configuration.
    refused: list[str] = []
    hits: dict[str, dict] = {}
    owned: set[str] = set()
    for spec in specs:
        impl = [hc.norm(p) for p in spec.get("implements_in", [])]
        verify = sorted(p for p in impl if verify_re and verify_re.match(p))
        matched = sorted(f for f in files if f in impl)
        owned.update(impl)
        if matched:
            hits[spec["id"]] = {"title": spec.get("title", ""), "matched": matched, "verify": verify}

    unmapped = sorted(f for f in files if scope_re.match(f) and f not in owned) if scope_re else []

    if not hits:
        hc.say(f"{len(files)} changed file(s) map to no spec — no registered verify script.")
    for sid in sorted(hits):
        h = hits[sid]
        # Everything below is printed through `hc.say()`, the single stdout exit. It matters most
        # here of all places: id, title and the filenames are repo-supplied, and this output's
        # consumer is a MODEL told to run the `run:` lines — so a newline in any of them could spell
        # a `run:` line nobody registered (ADR 0032's review; same rule, model instead of `sh`).
        hc.say(f"spec {sid} — {h['title']}")
        for f in h["matched"]:
            hc.say(f"  changed: {f}")
        if h["verify"]:
            for v in h["verify"]:
                cmd = hc.verify_command(cfg, v, refused)
                # A refusal must NOT occupy the `run:` slot. This output's only consumer is the
                # /verify skill — an LLM told to run the printed commands — and unlike the two
                # shell parsers it has no `(`-prefix convention to fall back on. So a refused
                # path gets a differently-labelled line that reads as a finding, not a command.
                hc.say(f"  run:     {cmd}" if not cmd.startswith("(")
                       else "  REFUSED: this spec's registered verify script path is not a safe "
                            "command argument — see the warning below. NOTHING was run for it, and "
                            "that is a coverage gap, not a pass.")
        else:
            hc.say("  (no verify script registered in implements_in for this spec)")
        if cfg["ui_prefix"] and any(f.startswith(cfg["ui_prefix"]) for f in h["matched"]):
            hc.say("  note:    UI surface changed — registered scripts do not cover component"
                   " rendering; say so plainly or cover it with a browser-level test")
    if unmapped:
        hc.say("unmapped product files (no spec owner — a slice-retro UNMAPPED finding in the making):")
        for f in unmapped:
            hc.say(f"  {f}")
    for w in refused:
        hc.warn(w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
