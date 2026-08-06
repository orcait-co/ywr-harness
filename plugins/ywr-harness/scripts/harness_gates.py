"""Changed files -> deterministic gate commands + a review-tier verdict. Backend for /slice-close.

Advisory only — always exits 0; nothing is executed. It prints the commands a slice close should
run BEFORE any LLM review, and the review tier those files earn. It also checks any declared
claude.ai Artifact against the README — link present, title starts with the repo name (ADR
0032); the emitter only reports, and the vendored CI fails on `artifact: VIOLATION`.

Usage:
  python harness_gates.py                       # working tree vs HEAD + untracked
  python harness_gates.py --range main~3..HEAD  # slice range UNIONED with the working tree
  python harness_gates.py path/to/file [...]    # explicit files
  python harness_gates.py --repo <dir>

Both the gate commands and the tier come from `.harness.json` via harness_config, so a repo
declares WHICH stack and WHICH surfaces it has, never what command runs. Adding a stack is a
change to the closed `GATES` set in the canon — reviewed once, available to every repo. A gate
that is the repo's own script (a path no repo-independent selector could name) is declared as a
script gate — closed-set runner + validated repo-relative path, ADR 0024 — so the executable is
still never a repo-supplied string.

## Why the tier is computed here and not judged in prose

Review proportionality has a cheap wrong answer in both directions: a full multi-lens review on a
docs-only diff burns tokens, and a `small` tier on a diff that touches a critical surface buys a
weaker review exactly where it matters. The inputs (file count, changed lines, which surfaces
matched) are mechanical, so they are computed and PRINTED WITH THE REASON — a tier a reader cannot
audit is a tier nobody can correct.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

import harness_config as hc

hc.pin_utf8()

# ADR 0104's thresholds, generalised. A slice may be small by both measures and still be `full` if
# it touches a declared critical surface — size never overrides criticality.
SMALL_MAX_FILES = 5
SMALL_MAX_LINES = 150


def changed_lines(root: Path, rev_range: str | None, is_exempt=None) -> tuple[int, int] | None:
    """(total, counted) added+deleted across the range and the working tree. `counted` excludes
    paths `is_exempt` marks as declared docs-only surfaces (ADR 0035) — the size measure should
    not be inflated by files the declaration already says carry no executable meaning.

    The caller's `is_exempt` must decide by MEMBERSHIP in a set built from the same name-only
    listing that classified the review scope, never by matching patterns against this function's
    raw numstat text: a rename record prints as `old => new`, so a `^docs/`-anchored pattern
    would match the OLD name's prefix and exempt what is now a code file — measured, review
    2026-08-06, high: a docs→code rename carrying hundreds of changed lines earned `small`. A
    numstat record that is not a listed clean path (a rename record, a quoted path) therefore
    COUNTS: unknown is not weightless. None when the diff cannot be measured — reported as
    unknown rather than assumed small, because an unknown treated as 0 would silently downgrade
    every tier."""
    total = counted = 0
    got = False
    for args in ([("diff", "--numstat", rev_range)] if rev_range else []) + [("diff", "--numstat", "HEAD")]:
        try:
            for line in hc.git_lines(root, *args):
                parts = line.split("\t")
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    n = int(parts[0]) + int(parts[1])
                    total += n
                    path = parts[2] if len(parts) >= 3 else ""
                    if not (is_exempt and path and is_exempt(path)):
                        counted += n
                    got = True
        except subprocess.CalledProcessError:
            return None
    return (total, counted) if got else (0, 0)


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
    # `cur` comes from the clone's own `.git/config`, and the UNSET branch above returns a
    # deliberately TWO-line string — so this is the one status line that cannot go through
    # `hc.say()`. The repo-supplied part is sanitized here instead, which is the documented
    # awkward path for intentional multi-line output.
    return (f".githooks/ present but core.hooksPath points at '{hc.one_line(cur)}' — the harness "
            "hooks do not run in this clone")


# Case-insensitive hex on purpose — an uppercase artifact id must not fail as "not an artifact
# URL" (the 0.18.0 lesson: an over-strict URL gate is a false BLOCK, not a leak).
# `\Z`, not `$`: Python's `$` ALSO matches just before a trailing newline, so `<url>\n` would pass
# a `$`-anchored full-match check while carrying the one character that can split an output line
# (the same class as the queued SAFE_TOKEN `$` note, 2026-07-29 — an anchor that admits a newline
# is not a full-match anchor).
ARTIFACT_URL = re.compile(r"^https://claude\.ai/code/artifact/[0-9A-Fa-f-]+\Z")


def repo_name(root: Path) -> tuple[str, str]:
    """(name, source). The origin remote's basename when one exists — a local clone can be
    renamed freely, the remote survives it — falling back to the work-tree directory name. The
    source is always reported: a title judged against a name the reader did not expect must be
    diagnosable from the output alone."""
    try:
        out = subprocess.run(["git", "remote", "get-url", "origin"],
                             cwd=root, capture_output=True, text=True)
        if out.returncode == 0:
            tail = re.split(r"[/:]", out.stdout.strip().replace("\\", "/").rstrip("/"))[-1]
            tail = tail[:-4] if tail.endswith(".git") else tail
            if tail:
                return tail, "origin remote"
    except OSError:
        pass
    return root.name, "directory name"


def title_has_prefix(title: str, name: str) -> bool:
    """True when `title` starts with `name` at a non-alphanumeric boundary, case-insensitively.
    The convention is `<repo> · <purpose>`: a bare startswith would bless 'awsome docs' for a
    repo named 'aws', and a case-sensitive one would block a legitimate 'AWS · …'."""
    t = title.strip()
    if not t.lower().startswith(name.lower()):
        return False
    rest = t[len(name):]
    return not rest[:1].isalnum()


def artifact_status(root: Path, cfg: dict, warns: list[str]) -> list[str]:
    """One `artifact:` line per declared item (ADR 0032) — `ok` or `VIOLATION` — or the
    `none declared` report. The vendored CI fails on `^artifact: VIOLATION`; the emitter itself
    stays advisory. Violations are ALSO appended to `warns`: stdout is where CI's fail step
    reads, stderr is what the pre-commit hook shows a human. A malformed declaration is a
    VIOLATION, never a drop — a typo that silently disabled enforcement would read as coverage
    (the same posture as CI failing on an unparseable settings file).

    The lines are returned, not printed: `hc.say()` is the single stdout exit that guarantees one
    line per line, so nothing here needs to remember to escape. That guarantee is load-bearing —
    the values echoed below are repo-supplied, and one carrying a newline would otherwise forge the
    `gates:` … `review tier:` window both output parsers execute from (measured; see `say`)."""
    arts = cfg["artifacts"]
    if arts.get("malformed"):
        warns.append("artifacts: declaration malformed — CI fails on this (ADR 0032)")
        return [f"artifact: VIOLATION — .harness.json artifacts is malformed ({arts['malformed']})"]
    items = arts["items"]
    if not items:
        return ["artifact: none declared — README link check disabled (a repo with a claude.ai "
                'Artifact declares it under "artifacts" in .harness.json)']
    name, source = repo_name(root)
    readme = arts["readme"]
    try:
        text = (root / readme).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = None
    lines: list[str] = []
    bad = 0
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            lines.append(f"artifact: VIOLATION — items[{i}] is not an object with 'url' and 'title'")
            bad += 1
            continue
        for key in it:
            if key not in ("url", "title") and not str(key).startswith("//"):
                warns.append(f"artifacts.items[{i}]: unknown key '{key}' ignored (known: url, title)")
        url = str(it.get("url") or "")
        title = str(it.get("title") or "")
        problems = []
        # A control character is refused at the DECLARATION layer too, not only escaped for
        # display: `one_line()` keeps the output honest whatever is declared, but a declaration
        # carrying a newline is either a typo or an attempt to forge an output line, and both
        # deserve to be told rather than quietly rendered as `\n`.
        if hc.has_control(url) or hc.has_control(title):
            problems.append("url/title contains a control character (newline, tab, …) — remove it; "
                            "a declared value is echoed on ONE status line")
        if not ARTIFACT_URL.match(url):
            problems.append("url is not a claude.ai Artifact URL "
                            "(want https://claude.ai/code/artifact/<id>)")
        if not title.strip():
            problems.append("title missing")
        elif not title_has_prefix(title, name):
            problems.append(f"title does not start with repo name '{name}' (from {source}) — "
                            "convention: <repo> · <purpose>")
        if text is None:
            problems.append(f"README '{readme}' cannot be read, so the link cannot be verified")
        elif ARTIFACT_URL.match(url) and url not in text:
            problems.append(f"{readme} does not contain the declared URL — add the link")
        if problems:
            label = f"'{title}'" if title.strip() else (url or f"items[{i}]")
            lines.append(f"artifact: VIOLATION — {label}: " + "; ".join(problems))
            bad += 1
        else:
            lines.append(f"artifact: ok — {readme} links {url} · title '{title}' starts with "
                         f"repo name '{name}' (from {source})")
    if bad:
        warns.append(f"artifacts: {bad} declared item(s) violate the README-link/title rule — "
                     "CI fails on these (ADR 0032)")
    return lines


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
    # Above `gates:` on purpose — outside the window both output parsers consume — and BEFORE the
    # empty-scope return: CI's push-to-main run has no changed files and is an enforcement point.
    for line in artifact_status(root, cfg, late):
        hc.say(line)
    if not files:
        for w in warns + late:
            hc.warn(w)
        hc.say("no changed files — nothing to gate")
        return 0

    # --- groups -> gate commands ---------------------------------------------------------------
    # Keyed by POSITION, not by name. A name is a label — two groups can legitimately share one, and
    # since names are sanitized for display two DIFFERENT declared names can also collapse to the
    # same escaped string. Either way a name-keyed map silently hands one group the other's file
    # list, so each group's own gates would run against files it never claimed. The index is the
    # only key that is unique by construction.
    grouped: dict[int, list[str]] = {}
    for i, g in enumerate(cfg["groups"]):
        rx = hc.compile_re(g["match"], f"groups[{g['name']}].match", late)
        grouped[i] = sorted(f for f in files if rx and rx.match(f)) if rx else []

    claimed = {f for fs in grouped.values() for f in fs}
    ungrouped = sorted(set(files) - claimed)

    hc.say("gates:")
    emitted = 0
    seen: set[str] = set()
    for i, g in enumerate(cfg["groups"]):
        fs = grouped[i]
        if not fs:
            continue
        hc.say(f"  [{g['name']}] {len(fs)} file(s)")
        if not g["gates"]:
            hc.say("    (no gate declared for this group — nothing deterministic runs on it)")
        # A filename is repo-supplied text: one containing a space, quote or '#' cannot be passed
        # through `sh -c` (or past either output parser) as one argument, so it is left OUT of the
        # gate's argument list. Never silent — an excluded file is an ungated file.
        unsafe = hc.unsafe_files(g, fs)
        if unsafe and any(hc.gate_is_scoped(gate) for gate in g["gates"]):
            hc.say(f"    ({len(unsafe)} file(s) EXCLUDED from this group's gate arguments — unsafe "
                   "characters for a command argument, so no deterministic gate covers them)")
            for f in unsafe:
                # A filename is repo-supplied text, and this line sits INSIDE the gate-command
                # window: the leading `(` keeps the first line out of both parsers, but a name
                # carrying a newline would put its remainder on a line that starts with four
                # spaces and no `(` — a forged command. git's default `core.quotePath` escapes such
                # names, which is a mitigation living in someone else's config, not a guarantee.
                hc.say(f"    (excluded: {f})")
            late.append(f"groups[{g['name']}]: {len(unsafe)} changed file(s) could not be passed "
                        "to a gate command and are UNGATED — rename them or gate them by hand")
        for gate in g["gates"]:
            cmd = hc.gate_command(gate, g, fs, late)
            if cmd.startswith("("):
                # gate_command refused or skipped this one. It is already a parenthetical, so it
                # prints as-is (both parsers skip it) and must NOT count toward `emitted` — a
                # refusal that inflated the count would read as a gate that ran.
                hc.say(f"    {cmd}")
                continue
            if cmd in seen:
                # A whole-program gate declared on several groups composes to the same command,
                # and running it once per group is waste, not coverage. The '(' prefix keeps this
                # line out of both output parsers (CI extraction and pre-commit exclude it).
                hc.say(f"    (already emitted above — deduplicated: {cmd})")
                continue
            seen.add(cmd)
            whole = "" if hc.gate_is_scoped(gate) else "   # whole-program: gate on slice files or newly introduced only"
            hc.say(f"    {cmd}{whole}")
            emitted += 1
    if emitted == 0:
        hc.say("  (none — no declared group matched, or matched groups declare no gates)")

    # Never silent: a file no group claims is a file no deterministic gate sees.
    if ungrouped:
        hc.say(f"ungrouped ({len(ungrouped)} file(s) — no declared group matched, so NO deterministic gate covers them):")
        for f in ungrouped:
            hc.say(f"  {f}")

    # --- review tier ---------------------------------------------------------------------------
    rev = cfg["review"]
    # docs_only is compiled ONCE: the same patterns are consulted per changed file AND per
    # numstat path, and compile_re warns on every call for a bad pattern — once per pattern is
    # the signal, N× is noise.
    docs_rx = [rx for rx in (hc.compile_re(p, "review.docs_only", late) for p in rev["docs_only"]) if rx]

    def docs_exempt(path: str) -> bool:
        return any(rx.search(path) for rx in docs_rx)

    # The exemption set is built from `files` — the SAME name-only listing that builds
    # `code_files` below — and changed_lines gets a membership test, never the regexes: one
    # classification, two measures, so the branch decision and the printed figures cannot
    # disagree, and a numstat rename record (`old => new`) can never regex-match its OLD name
    # into an exemption (review 2026-08-06, high — reproduced with a docs→code rename).
    exempt_paths = {f for f in files if docs_exempt(f)}
    sizes = changed_lines(root, args.rev_range, lambda p: p in exempt_paths) if prov.get("source") != "explicit" else None
    docs_only = bool(rev["docs_only"]) and all(f in exempt_paths for f in files)
    critical = [f for f in files if rev["critical"] and match_any(rev["critical"], f, late, "review.critical")]
    code_files = [f for f in files if f not in exempt_paths]
    harness_only = bool(rev["harness_layer"]) and bool(code_files) and all(
        match_any(rev["harness_layer"], f, late, "review.harness_layer") for f in code_files)

    # Size is measured over the NON-docs subset (ADR 0035): docs_only files riding along with a
    # small behavioral change inflate the total without adding review surface. The SCOPE is not
    # narrowed anywhere — only the measure — and a non-empty exclusion is stated on the tier
    # line, never silent. With no docs_only declared (or none in the diff) the counted figures
    # equal the totals and the wording below is byte-identical to the unweighted form.
    excluded = len(files) - len(code_files)
    lines, counted = sizes if sizes is not None else (None, None)
    exempt_note = (f" — {excluded} docs-only file(s) excluded from the size measure, "
                   "still in review scope") if excluded else ""

    if critical:
        tier, why = "full", f"critical surface touched ({', '.join(critical[:3])}) — size never overrides criticality"
    elif docs_only:
        tier, why = "skip", "every changed file is a declared docs surface; deterministic gates suffice"
    elif harness_only:
        tier, why = "small", "code-bearing changes are confined to the declared harness layer"
    elif sizes is None:
        tier, why = "full", "changed-line count could not be measured — unknown is not small"
    elif len(code_files) <= SMALL_MAX_FILES and counted <= SMALL_MAX_LINES:
        tier, why = "small", (f"{len(code_files)} counted file(s) / {counted} counted line(s), no critical surface{exempt_note}"
                              if excluded else
                              f"{len(files)} file(s) / {lines} changed line(s), no critical surface")
    else:
        tier, why = "full", (f"{len(code_files)} counted file(s) / {counted} counted line(s){exempt_note}"
                             if excluded else
                             f"{len(files)} file(s) / {lines} changed line(s)")

    hc.say(f"review tier: {tier} — {why}")
    if not (rev["docs_only"] or rev["harness_layer"] or rev["critical"]):
        print("  warn: no review surfaces declared in .harness.json — the tier rests on size alone",
              file=sys.stderr)
    hc.say(f"review canon: {cfg['review_canon']}" + ("" if (root / cfg["review_canon"]).exists()
           else "   (NOT FOUND — invariants must come from somewhere; the close cannot cite a missing file)"))
    if cfg["handoff"]:
        hc.say(f"handoff: {cfg['handoff']}")

    # Printed AFTER the tier so the hook's output parser (which stops at `review tier:`) can never
    # mistake it for a gate command.
    hooks = hooks_status(root)
    if hooks:
        print(f"hooks: {hooks}")

    for w in warns + late:
        hc.warn(w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
