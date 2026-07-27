"""Changed files -> deterministic gate commands + a review-tier verdict. Backend for /slice-close.

Advisory only — always exits 0; nothing is executed. It prints the commands a slice close should
run BEFORE any LLM review, and the review tier those files earn.

Usage:
  python harness_gates.py                       # working tree vs HEAD + untracked
  python harness_gates.py --range main~3..HEAD  # slice range UNIONED with the working tree
  python harness_gates.py path/to/file [...]    # explicit files
  python harness_gates.py --repo <dir>

Both the gate commands and the tier come from `.harness.json` via harness_config, so a repo
declares WHICH stack and WHICH surfaces it has, never what command runs. Adding a stack is a
change to the closed `GATES` set in the canon — reviewed once, available to every repo.

## Why the tier is computed here and not judged in prose

Review proportionality has a cheap wrong answer in both directions: a full multi-lens review on a
docs-only diff burns tokens, and a `small` tier on a diff that touches a critical surface buys a
weaker review exactly where it matters. The inputs (file count, changed lines, which surfaces
matched) are mechanical, so they are computed and PRINTED WITH THE REASON — a tier a reader cannot
audit is a tier nobody can correct.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import harness_config as hc

hc.pin_utf8()

# ADR 0104's thresholds, generalised. A slice may be small by both measures and still be `full` if
# it touches a declared critical surface — size never overrides criticality.
SMALL_MAX_FILES = 5
SMALL_MAX_LINES = 150


def changed_lines(root: Path, rev_range: str | None) -> int | None:
    """Total added+deleted across the range and the working tree. None when it cannot be measured —
    reported as unknown rather than assumed small, because an unknown treated as 0 would silently
    downgrade every tier."""
    total = 0
    got = False
    for args in ([("diff", "--numstat", rev_range)] if rev_range else []) + [("diff", "--numstat", "HEAD")]:
        try:
            for line in hc.git_lines(root, *args):
                parts = line.split("\t")
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    total += int(parts[0]) + int(parts[1])
                    got = True
        except subprocess.CalledProcessError:
            return None
    return total if got else 0


def hooks_status(root: Path) -> str | None:
    """One line on whether THIS CLONE has the scaffolded git hooks wired, or None when the repo has
    no `.githooks/` to wire.

    `core.hooksPath` lives in `.git/config`, which is per-clone and never committed (ADR 0015). So a
    repo can carry `.githooks/` in its tree while any given clone runs none of it, and an unwired
    clone is otherwise indistinguishable from a wired one — the scaffold cannot reach a machine it
    never ran on, but this line does, because it prints on every /slice-close and every CI run.
    """
    if not (root / ".githooks").is_dir():
        return None
    try:
        out = subprocess.run(
            ["git", "config", "--local", "--get", "core.hooksPath"],
            cwd=root, capture_output=True, text=True,
        )
    except OSError:
        return ".githooks/ present, but git could not be run here — wiring unknown"
    cur = (out.stdout or "").strip()
    if out.returncode != 0 or not cur:
        return (".githooks/ present but core.hooksPath is UNSET — NO git hook runs in this clone\n"
                "       run: git config core.hooksPath .githooks")
    if cur == ".githooks":
        return ".githooks/ wired (core.hooksPath)"
    return (f".githooks/ present but core.hooksPath points at '{cur}' — the harness hooks "
            "do not run in this clone")


def match_any(patterns: list[str], path: str, warns: list[str], field: str) -> bool:
    for p in patterns:
        rx = hc.compile_re(p, field, warns)
        if rx and rx.search(path):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Emit deterministic gate commands and a review tier.")
    ap.add_argument("--range", dest="rev_range", default=None)
    ap.add_argument("--repo", dest="repo", default=None)
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    cfg, warns = hc.load(root)

    try:
        files, prov = hc.changed_files(root, args.rev_range, args.files)
    except subprocess.CalledProcessError as e:
        print(f"git failed: {(e.stderr or '').strip()}", file=sys.stderr)
        return 0

    late: list[str] = []
    hc.print_scope(files, prov)
    if not files:
        for w in warns:
            print(f"warn: {w}", file=sys.stderr)
        print("no changed files — nothing to gate")
        return 0

    # --- groups -> gate commands ---------------------------------------------------------------
    grouped: dict[str, list[str]] = {}
    for g in cfg["groups"]:
        rx = hc.compile_re(g["match"], f"groups[{g['name']}].match", late)
        grouped[g["name"]] = sorted(f for f in files if rx and rx.match(f)) if rx else []

    claimed = {f for fs in grouped.values() for f in fs}
    ungrouped = sorted(set(files) - claimed)

    print("gates:")
    emitted = 0
    for g in cfg["groups"]:
        fs = grouped[g["name"]]
        if not fs:
            continue
        print(f"  [{g['name']}] {len(fs)} file(s)")
        if not g["gates"]:
            print("    (no gate declared for this group — nothing deterministic runs on it)")
        for gate in g["gates"]:
            whole = "" if hc.GATES[gate]["files"] else "   # whole-program: gate on slice files or newly introduced only"
            print(f"    {hc.gate_command(gate, g, fs)}{whole}")
            emitted += 1
    if emitted == 0:
        print("  (none — no declared group matched, or matched groups declare no gates)")

    # Never silent: a file no group claims is a file no deterministic gate sees.
    if ungrouped:
        print(f"ungrouped ({len(ungrouped)} file(s) — no declared group matched, so NO deterministic gate covers them):")
        for f in ungrouped:
            print(f"  {f}")

    # --- review tier ---------------------------------------------------------------------------
    rev = cfg["review"]
    lines = changed_lines(root, args.rev_range) if prov.get("source") != "explicit" else None
    docs_only = bool(rev["docs_only"]) and all(match_any(rev["docs_only"], f, late, "review.docs_only") for f in files)
    critical = [f for f in files if rev["critical"] and match_any(rev["critical"], f, late, "review.critical")]
    code_files = [f for f in files if not (rev["docs_only"] and match_any(rev["docs_only"], f, late, "review.docs_only"))]
    harness_only = bool(rev["harness_layer"]) and bool(code_files) and all(
        match_any(rev["harness_layer"], f, late, "review.harness_layer") for f in code_files)

    if critical:
        tier, why = "full", f"critical surface touched ({', '.join(critical[:3])}) — size never overrides criticality"
    elif docs_only:
        tier, why = "skip", "every changed file is a declared docs surface; deterministic gates suffice"
    elif harness_only:
        tier, why = "small", "code-bearing changes are confined to the declared harness layer"
    elif lines is None:
        tier, why = "full", "changed-line count could not be measured — unknown is not small"
    elif len(files) <= SMALL_MAX_FILES and lines <= SMALL_MAX_LINES:
        tier, why = "small", f"{len(files)} file(s) / {lines} changed line(s), no critical surface"
    else:
        tier, why = "full", f"{len(files)} file(s) / {lines if lines is not None else '?'} changed line(s)"

    print(f"review tier: {tier} — {why}")
    if not (rev["docs_only"] or rev["harness_layer"] or rev["critical"]):
        print("  warn: no review surfaces declared in .harness.json — the tier rests on size alone",
              file=sys.stderr)
    print(f"review canon: {cfg['review_canon']}" + ("" if (root / cfg["review_canon"]).exists()
          else "   (NOT FOUND — invariants must come from somewhere; the close cannot cite a missing file)"))
    if cfg["handoff"]:
        print(f"handoff: {cfg['handoff']}")

    # Printed AFTER the tier so the hook's output parser (which stops at `review tier:`) can never
    # mistake it for a gate command.
    hooks = hooks_status(root)
    if hooks:
        print(f"hooks: {hooks}")

    for w in warns + late:
        print(f"warn: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
