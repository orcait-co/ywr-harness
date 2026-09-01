"""Changed files -> deterministic gate commands + a review-tier verdict. Backend for /slice-close.

Advisory — nothing is executed, and it exits 0 with ONE exception: when the changed-file scope
itself cannot be resolved (a git failure), it prints a stdout `scope: FAILED` marker and exits
non-zero (ADR 0041). An empty advisory output reads as a pass to every consumer — CI greps this
stdout, and no ungrouped marker + no artifact line + no gate commands is indistinguishable from
"all clear" — so unknown must fail loudly, the same principle the tier logic already applies
("unknown is not small"). It prints the commands a slice close should run BEFORE any LLM review,
and the review tier those files earn. It also checks any declared claude.ai Artifact against the
README — link present, title starts with the repo name (ADR 0032); the emitter only reports, and
the vendored CI fails on `artifact: VIOLATION`.

Usage:
  python harness_gates.py                       # working tree vs HEAD + untracked
  python harness_gates.py --range main~3..HEAD  # slice range UNIONED with the working tree
  python harness_gates.py path/to/file [...]    # explicit files
  python harness_gates.py --all                 # full-tree audit: ls-files + untracked (ADR 0041)
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
import json
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

# The one file whose schema the canon itself owns (ADR 0038). The safe keys feed REPORTING only;
# every other key reaches command composition, tier, or gate coverage, so a change to one is
# critical in every repo, declared or not — the declaration cannot opt itself out.
# `artifacts` LEFT this set with ADR 0068: `items[].check` composes a command the CI runs, so an
# artifacts edit is critical now — over-approximate for a URL/title typo, and erring toward
# critical is the posture the whole mechanism stands on.
DECL_FILE = ".harness.json"
DECL_SAFE_KEYS = {"docs", "handoff"}


def _drop_comment_keys(v):
    """Recursively remove '//'-prefixed keys — the schema's comment convention everywhere. A
    comment edit is prose, not a declaration change, and must compare equal."""
    if isinstance(v, dict):
        return {k: _drop_comment_keys(x) for k, x in v.items() if not str(k).startswith("//")}
    if isinstance(v, list):
        return [_drop_comment_keys(x) for x in v]
    return v


def decl_changed_keys(root: Path, rev_range: str | None) -> list[str] | None:
    """Top-level declaration keys whose comment-stripped values differ between the diff base and
    the working tree, or None when that cannot be determined — the caller treats unknown as
    critical, never as safe (a newly added declaration and an unparseable side both land here).
    Base = the left side of --range when given, else HEAD; a three-dot range uses the left rev
    as-is, which for A...B can only over-approximate the change set — erring toward critical.
    Decoded as UTF-8 explicitly: text=True would use the console codepage on Windows and a
    declaration carrying non-ASCII (artifact titles do) would fail or silently mis-compare."""
    base = "HEAD"
    if rev_range:
        left = re.split(r"\.\.\.?", rev_range, maxsplit=1)[0].strip()
        if left:
            base = left
    try:
        out = subprocess.run(["git", "show", f"{base}:{DECL_FILE}"],
                             cwd=root, capture_output=True, check=True)
        old = json.loads(out.stdout.decode("utf-8"))
        new = json.loads((root / DECL_FILE).read_text(encoding="utf-8"))
    except (OSError, subprocess.CalledProcessError, ValueError):
        # ValueError covers json.JSONDecodeError and UnicodeDecodeError — both are subclasses.
        return None
    old, new = _drop_comment_keys(old), _drop_comment_keys(new)
    if not isinstance(old, dict) or not isinstance(new, dict):
        return None
    return sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))


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


def exec_bit_gap(root: Path) -> str:
    """POSIX only: the scaffold hooks present under `.githooks/` that this checkout holds
    NON-executable — git runs hooks from the working tree and silently skips one without the
    bit. Empty string when nothing is wrong or the question does not apply (Windows git invokes
    hooks through sh regardless of the mode). The committed mode travels with the repo, so a
    Windows-scaffolded repo (index mode 100644, ADR 0056) surfaces here on every POSIX clone —
    including CI's ubuntu checkout, which is what makes the gap visible to an all-Windows org.
    Filenames printed are constants from the scaffold's own set, never repo-supplied text."""
    import os
    if os.name != "posix":
        return ""
    bad = [h for h in ("pre-commit", "pre-push", "post-commit")
           if (root / ".githooks" / h).is_file()
           and not os.access(root / ".githooks" / h, os.X_OK)]
    if not bad:
        return ""
    return ("\n       " + f"{len(bad)} hook(s) NOT executable ({', '.join(bad)}) — git silently "
            "skips them in this clone (ADR 0056)\n"
            "       run: chmod +x .githooks/*   (this clone) and commit the mode for every "
            "future clone: git update-index --chmod=+x .githooks/*")


def hooks_status(root: Path) -> str | None:
    """One line on whether THIS CLONE has the scaffolded git hooks wired, or None when the repo has
    no `.githooks/` to wire.

    `core.hooksPath` lives in `.git/config`, which is per-clone and never committed (ADR 0015). So a
    repo can carry `.githooks/` in its tree while any given clone runs none of it, and an unwired
    clone is otherwise indistinguishable from a wired one — the scaffold cannot reach a machine it
    never ran on, but this line does, because it prints on every /slice-close and every CI run.
    The executable bit is the second per-checkout axis of the same gap (ADR 0056), appended by
    `exec_bit_gap` on the UNSET and wired branches. The foreign-hooksPath branch deliberately
    omits it: git is not consulting `.githooks/` there, so a chmod suggestion would read as a
    remedy that fixes nothing — the only remedy on that branch is the hooksPath one (review
    2026-08-17, medium).
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
                "       run: git config core.hooksPath .githooks" + exec_bit_gap(root))
    if cur == ".githooks":
        return ".githooks/ wired (core.hooksPath)" + exec_bit_gap(root)
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
# (the same class as SAFE_TOKEN, which uses `\Z` for the same reason — an anchor that admits a
# newline is not a full-match anchor).
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


def artifact_status(root: Path, cfg: dict, warns: list[str]) -> tuple[list[str], list[str]]:
    """(`artifact:` lines, validated drift-check commands). One line per declared item
    (ADR 0032) — `ok` or `VIOLATION` — or the `none declared` report. The vendored CI fails on
    `^artifact: VIOLATION`; the emitter itself stays advisory. Violations are ALSO appended to
    `warns`: stdout is where CI's fail step reads, stderr is what the pre-commit hook shows a
    human. A malformed declaration is a VIOLATION, never a drop — a typo that silently disabled
    enforcement would read as coverage (the same posture as CI failing on an unparseable
    settings file).

    ADR 0068 adds two per-item keys. `source` (the committed Artifact source file) is
    completeness: the path must be allowlist-clean and EXIST. `check` ({runner, script},
    validated by `hc.artifact_check`) composes ONE whole-program command per valid item,
    returned for the caller to emit inside the `gates:` window — CI's existing extraction runs
    it, pre-commit's existing `# whole-program` rule defers it, and the window's `seen` set
    dedupes it against an identical group gate. A check on a VIOLATING item is never returned:
    half-validated enforcement reading as enforcement is the defect class this line exists for.

    The lines are returned, not printed: `hc.say()` is the single stdout exit that guarantees one
    line per line, so nothing here needs to remember to escape. That guarantee is load-bearing —
    the values echoed below are repo-supplied, and one carrying a newline would otherwise forge the
    `gates:` … `review tier:` window both output parsers execute from (measured; see `say`)."""
    arts = cfg["artifacts"]
    if arts.get("malformed"):
        warns.append("artifacts: declaration malformed — CI fails on this (ADR 0032)")
        return ([f"artifact: VIOLATION — .harness.json artifacts is malformed ({arts['malformed']})"], [])
    items = arts["items"]
    if not items:
        return (["artifact: none declared — README link check disabled (a repo with a claude.ai "
                'Artifact declares it under "artifacts" in .harness.json)'], [])
    name, source = repo_name(root)
    readme = arts["readme"]
    try:
        text = (root / readme).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = None
    lines: list[str] = []
    checks: list[str] = []
    bad = 0
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            lines.append(f"artifact: VIOLATION — items[{i}] is not an object with 'url' and 'title'")
            bad += 1
            continue
        for key in it:
            if key not in ("url", "title", "source", "check") and not str(key).startswith("//"):
                warns.append(f"artifacts.items[{i}]: unknown key '{key}' ignored "
                             "(known: url, title, source, check)")
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
        # --- ADR 0068: committed source + drift check --------------------------------------------
        # `src` on purpose — `source` above is the repo-NAME provenance from repo_name().
        src = it.get("source")
        check = it.get("check")
        extras: list[str] = []
        src_ok = False
        if src is not None:
            src = str(src)
            if not hc.token_ok(src) or src.startswith("-"):
                problems.append(f"source '{hc.one_line(src)}' refused (a repo-relative path of "
                                "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-')")
            elif not (root / src).is_file():
                problems.append(f"declared source '{src}' is not a file in the tree — the "
                                "committed Artifact source is exactly what this key asserts "
                                "(ADR 0068)")
            else:
                src_ok = True
                extras.append(f"source {src} committed")
        cmd = ""
        if check is not None:
            if src is None:
                problems.append("check declared without source — a drift check needs the "
                                "committed file it guards (ADR 0068)")
            elif not isinstance(check, dict):
                problems.append("check must be an object {runner, script} (ADR 0068)")
            else:
                cmd = hc.artifact_check(check, f"artifacts.items[{i}].check", problems,
                                        warns, root)
                if cmd:
                    extras.append("check declared — emitted under gates: as whole-program")
        elif src_ok:
            extras.append("no check declared — drift between this source and its generator "
                          "is unenforced")
        elif src is None:
            # A url+title-only item (ADR 0032's shape) is legal — but the bare ok line matched
            # NONE of the artifact-publish skill's step-1 shapes, so the skill had no defined
            # outcome for it (dist issue #2). Name the shape: hand-published, nothing committed
            # to republish from — the skill's taxonomy and this line must agree.
            extras.append("no source declared — hand-published page (ADR 0032 shape); not "
                          "publishable via /ywr-harness:artifact-publish")
        if problems:
            label = f"'{title}'" if title.strip() else (url or f"items[{i}]")
            lines.append(f"artifact: VIOLATION — {label}: " + "; ".join(problems))
            bad += 1
        else:
            if cmd:
                checks.append(cmd)
            tail = (" · " + " · ".join(extras)) if extras else ""
            lines.append(f"artifact: ok — {readme} links {url} · title '{title}' starts with "
                         f"repo name '{name}' (from {source})" + tail)
    if bad:
        warns.append(f"artifacts: {bad} declared item(s) violate the README-link/title/source "
                     "rule — CI fails on these (ADR 0032/0068)")
    return lines, checks


def match_any(patterns: list[str], path: str, warns: list[str], field: str) -> bool:
    for p in patterns:
        rx = hc.compile_re(p, field, warns)
        if rx and rx.search(path):
            return True
    return False


def emit_tail(root: Path, cfg: dict, warns: list[str], late: list[str]) -> int:
    """The common trailer after the tier line — review canon, handoff, hooks, queued warnings.
    Shared by the per-slice path and the full-tree audit path (ADR 0041) so the two can never
    disagree on what a run reports after its verdict."""
    hc.say(f"review canon: {cfg['review_canon']}" + ("" if (root / cfg["review_canon"]).exists()
           else "   (NOT FOUND — invariants must come from somewhere; the close cannot cite a missing file)"))
    if cfg["handoff"]:
        # A trailing '/' declares a per-work-line directory (ADR 0040); annotated here so the
        # close instruction "update the handoff the emitter named" is unambiguous where it is read.
        hint = " — directory: one resume file per work line" if cfg["handoff"].endswith("/") else ""
        hc.say(f"handoff: {cfg['handoff']}{hint}")

    # Printed AFTER the tier so the hook's output parser (which stops at `review tier:`) can never
    # mistake it for a gate command.
    hooks = hooks_status(root)
    if hooks:
        print(f"hooks: {hooks}")

    for w in warns + late:
        hc.warn(w)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Emit deterministic gate commands and a review tier.")
    ap.add_argument("--range", dest="rev_range", default=None)
    ap.add_argument("--repo", dest="repo", default=None)
    ap.add_argument("--all", dest="all_files", action="store_true",
                    help="full-tree audit scope: git ls-files + untracked (ADR 0041 — CI push runs)")
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    cfg, warns = hc.load(root)

    if args.all_files and (args.rev_range or args.files):
        print("note: --all given — ignoring --range and explicit files", file=sys.stderr)

    try:
        files, prov = hc.changed_files(root, args.rev_range, args.files, args.all_files)
    except subprocess.CalledProcessError as e:
        # The one non-zero exit in this advisory script (ADR 0041). A silent return here passed
        # every downstream consumer: stdout is what CI greps, and an empty stdout carries no
        # ungrouped marker, no artifact line, and no gate commands — a job that ran nothing
        # reads green. Reproduced with an unreachable ref; the ordinary multi-writer triggers
        # are a force-pushed base branch and a stale fetch.
        print(f"git failed: {(e.stderr or '').strip()}", file=sys.stderr)
        hc.say("scope: FAILED — git could not resolve the changed-file scope; NOTHING below was "
               "computed. This run must not be read as a pass (ADR 0041).")
        return 1

    late: list[str] = []
    hc.print_scope(files, prov)
    # Above `gates:` on purpose — outside the window both output parsers consume — and BEFORE the
    # empty-scope return: CI's push-to-main run has no changed files and is an enforcement point.
    # The drift-check COMMANDS ride the gates window below instead (ADR 0068), so the empty-scope
    # path prints the completeness lines but runs no check — recorded residual; the next real
    # slice and the publish skill re-check.
    art_lines, art_checks = artifact_status(root, cfg, late)
    for line in art_lines:
        hc.say(line)
    if not files:
        if prov.get("source") == "all":
            # A full-tree audit's trailer facts (review-canon existence, hooks wiring) are TREE
            # facts, not diff facts — an empty tree still has answers, and hooks_status's own
            # contract says it prints on every CI run (review 2026-08-10, low).
            hc.say("no changed files — nothing to gate")
            return emit_tail(root, cfg, warns, late)
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
    leftover = set(files) - claimed
    # Built-in claims (ADR 0044): scaffold-placed paths no declared group matched. Declared
    # groups win by construction — only leftovers are consulted — and the claim is REPORTED
    # below, never silent: an absorbed file that printed nowhere would read as coverage.
    scaffold_claimed = sorted(leftover & hc.SCAFFOLD_CLAIMS)
    ungrouped = sorted(leftover - hc.SCAFFOLD_CLAIMS)

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
            # "UNGATED" was an overstatement when the group ALSO declares a whole-program gate:
            # that gate runs regardless of the argument list, so the excluded file is still
            # covered by it — only the file-scoped coverage is lost (queued 2026-07-29). The
            # coverage claim must match what actually runs, in both the note and the warning.
            whole_covers = any(not hc.gate_is_scoped(gate) for gate in g["gates"])
            if whole_covers:
                hc.say(f"    ({len(unsafe)} file(s) EXCLUDED from this group's file-scoped gate "
                       "arguments — unsafe characters for a command argument; the group's "
                       "whole-program gate still covers them)")
            else:
                hc.say(f"    ({len(unsafe)} file(s) EXCLUDED from this group's gate arguments — unsafe "
                       "characters for a command argument, so no deterministic gate covers them)")
            for f in unsafe:
                # A filename is repo-supplied text, and this line sits INSIDE the gate-command
                # window: the leading `(` keeps the first line out of both parsers, but a name
                # carrying a newline would put its remainder on a line that starts with four
                # spaces and no `(` — a forged command. git's default `core.quotePath` escapes such
                # names, which is a mitigation living in someone else's config, not a guarantee.
                hc.say(f"    (excluded: {f})")
            if whole_covers:
                late.append(f"groups[{g['name']}]: {len(unsafe)} changed file(s) could not be "
                            "passed as file-scoped gate arguments — the group's whole-program "
                            "gate still covers them; rename them to restore file-scoped coverage")
            else:
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
    # Declared-artifact drift checks (ADR 0068) — after the group gates, inside the same window,
    # so CI's extraction runs them and pre-commit's `# whole-program` rule defers them. The
    # header keeps the group-header shape (2-space `[label]`); the two COMMAND parsers (CI sed +
    # pre-commit CMDS awk) skip it, and pre-commit's THIRD parser — the MATCHED_GROUPS awk, which
    # reads 2-space `[label]` lines as group names — skips it by an explicit rule keyed on this
    # exact trailer (review 2026-08-31, high: the first cut garbled that report on every commit
    # whose CMDS was empty). Changing this header's wording means changing that awk rule too.
    # `seen` collapses a check a group already declared as its own gate (the canon's dogfood state).
    if art_checks:
        hc.say(f"  [artifacts] {len(art_checks)} declared drift check(s) — run on every slice "
               "(ADR 0068)")
        for cmd in art_checks:
            if cmd in seen:
                hc.say(f"    (already emitted above — deduplicated: {cmd})")
                continue
            seen.add(cmd)
            hc.say(f"    {cmd}   # whole-program: declared-artifact drift check (ADR 0068)")
            emitted += 1
    if emitted == 0:
        # Three causes share this line, and the third was unnamed until 2026-07-29's queue: a
        # group can DECLARE gates and still emit none, because every one was refused at load or
        # skipped/refused at composition (the parentheticals above). Cases O and Q anchor this
        # exact string — change them together.
        hc.say("  (none — no declared group matched, matched groups declare no gates, or every "
               "declared gate was refused or skipped)")

    # Built-in scaffold claims, stated with every path (ADR 0044). Line shapes are chosen for
    # the two output parsers: a column-0 header that matches neither window-close sentinel
    # (`^ungrouped (` / `^review tier:`) nor CI's `^ungrouped (` failure grep, and 2-space file
    # lines that neither extractor (`^ {4}[^ (]`, awk `/^    [^ (]/`) can read as a command.
    # The paths printed here are constants from the closed set, never repo-supplied text.
    if scaffold_claimed:
        hc.say(f"scaffold-claimed ({len(scaffold_claimed)} file(s) — placed or written by "
               "/ywr-harness:harness-init and claimed built-in; no groups entry needed — ADR 0044):")
        for f in scaffold_claimed:
            hc.say(f"  {f}")

    # Never silent: a file no group claims is a file no deterministic gate sees.
    if ungrouped:
        # The tail names the consequence: CI's "Fail on ungrouped files" step hard-fails on this
        # header while every local run stays advisory (ADR 0041's exit contract), so without it a
        # repo reads as passing right up to its first CI run (issue #55, ADR 0062).
        hc.say(f"ungrouped ({len(ungrouped)} file(s) — no declared group matched, so NO deterministic gate covers them; "
               "CI's harness-gates run FAILS on this — add a groups entry to .harness.json):")
        for f in ungrouped:
            hc.say(f"  {f}")

    # --- review tier ---------------------------------------------------------------------------
    if prov.get("source") == "all":
        # A tier is a slice property (ADR 0041): a whole tree earning "small" in a tiny repo
        # would be a meaningless label, and the declaration-diff and line-count measures below
        # answer questions no full-tree audit is asking. The line keeps the `review tier:`
        # prefix, which both output parsers (CI sed, pre-commit awk) use as their window-close
        # sentinel — an audit run that dropped it would hand the parsers an unterminated window.
        hc.say("review tier: full-tree audit — a tier applies to a slice; this run checks "
               "partition, artifact, and gate coverage over the whole tree (ADR 0041)")
        return emit_tail(root, cfg, warns, late)

    rev = cfg["review"]
    # docs_only is compiled ONCE: the same patterns are consulted per changed file AND per
    # numstat path, and compile_re warns on every call for a bad pattern — once per pattern is
    # the signal, N× is noise.
    docs_rx = [rx for rx in (hc.compile_re(p, "review.docs_only", late) for p in rev["docs_only"]) if rx]

    def docs_exempt(path: str) -> bool:
        return any(rx.search(path) for rx in docs_rx)

    # The exemption sets are built from `files` — the SAME name-only listing that builds
    # `code_files` below — and changed_lines gets a membership test, never the regexes: one
    # classification, two measures, so the branch decision and the printed figures cannot
    # disagree, and a numstat rename record (`old => new`) can never regex-match its OLD name
    # into an exemption (review 2026-08-06, high — reproduced with a docs→code rename).
    docs_paths = {f for f in files if docs_exempt(f)}

    # Derived-copy exemption (ADR 0037): a changed file under a declared copies prefix whose
    # CURRENT bytes equal its mapped source's adds no review surface — the deterministic
    # identity gate owns that relationship. Identity is a tree property, so BOTH sides are read
    # from the worktree: a drifted or deleted copy counts fully (and the identity gate fails the
    # build anyway). Chains are not resolved — every copies prefix maps directly to its
    # canonical source.
    def derived_source(path: str) -> str | None:
        for d in rev["derived"]:
            for c in d["copies"]:
                if path.startswith(c):
                    return d["source"] + path[len(c):]
        return None

    def identical_to_source(path: str) -> bool:
        src = derived_source(path)
        if not src or src == path:
            return False
        try:
            a, b = root / path, root / src
            # A symlink's DIFF is its target string, but a content read follows it — a link
            # retargeted at the source itself would compare "identical" while the reviewed
            # change is a redirection. Refused in the conservative direction: a link is never
            # an exempt copy, on either side (review 2026-08-07, medium).
            if a.is_symlink() or b.is_symlink():
                return False
            return a.read_bytes() == b.read_bytes()
        except OSError:
            return False

    derived_paths = {f for f in files if f not in docs_paths and identical_to_source(f)}
    exempt_paths = docs_paths | derived_paths
    sizes = changed_lines(root, args.rev_range, lambda p: p in exempt_paths) if prov.get("source") != "explicit" else None
    # `skip` stays a docs-only decision (ADR 0037): derived files never contribute to the
    # all-docs test, so a pure propagation diff earns `small` via an empty counted set, not
    # `skip` — the exemption narrows the measure and the criticality attribution, never the
    # trust class.
    docs_only = bool(rev["docs_only"]) and all(f in docs_paths for f in files)
    critical_all = [f for f in files if rev["critical"] and match_any(rev["critical"], f, late, "review.critical")]
    # A byte-identical copy cannot force `critical` — the source's own classification decides
    # (ADR 0037). Suppression is stated on the tier line below, never silent.
    critical = [f for f in critical_all if f not in derived_paths]
    crit_suppressed = [f for f in critical_all if f in derived_paths]
    code_files = [f for f in files if f not in exempt_paths]
    harness_only = bool(rev["harness_layer"]) and bool(code_files) and all(
        match_any(rev["harness_layer"], f, late, "review.harness_layer") for f in code_files)

    # The declaration's criticality is COMPUTED from which keys changed (ADR 0038): the safe
    # keys feed reporting only; anything else — or a diff that cannot be determined — is
    # critical in every repo, declared or not. Either way the verdict is stated with its input.
    decl_note = ""
    if DECL_FILE in files:
        # Explicit-files mode ignores --range everywhere else (print_scope says so on stderr),
        # so the base must not come from it here either — HEAD is the honest base for a
        # worktree question (review 2026-08-07, medium).
        keys = decl_changed_keys(root, args.rev_range if prov.get("source") != "explicit" else None)
        if keys is not None and all(k in DECL_SAFE_KEYS for k in keys):
            if DECL_FILE in critical:
                critical.remove(DECL_FILE)
            decl_note = ((f"declaration change confined to metadata keys ({', '.join(keys)})"
                          if keys else "declaration change is comment-only")
                         + " — not counted as critical")
        else:
            if DECL_FILE not in critical:
                critical.insert(0, DECL_FILE)
            shown = ", ".join(keys) if keys else "undetermined"
            decl_note = (f"declaration keys changed ({shown}) — the declaration decides what "
                         "runs and what gets reviewed, so it is critical in every repo")

    # Size is measured over the non-exempt subset (ADR 0035, extended by 0037): docs_only files
    # and byte-identical derived copies riding along with a small behavioral change inflate the
    # total without adding review surface. The SCOPE is not narrowed anywhere — only the measure
    # — and a non-empty exclusion is stated on the tier line, never silent. With neither class
    # in the diff the counted figures equal the totals and the wording below is byte-identical
    # to the unweighted form.
    lines, counted = sizes if sizes is not None else (None, None)
    ex_parts = []
    if docs_paths:
        ex_parts.append(f"{len(docs_paths)} docs-only file(s)")
    if derived_paths:
        ex_parts.append(f"{len(derived_paths)} byte-identical derived "
                        + ("copy" if len(derived_paths) == 1 else "copies"))
    exempt_note = (f" — {' and '.join(ex_parts)} excluded from the size measure, "
                   "still in review scope") if ex_parts else ""

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
                              if exempt_note else
                              f"{len(files)} file(s) / {lines} changed line(s), no critical surface")
    else:
        tier, why = "full", (f"{len(code_files)} counted file(s) / {counted} counted line(s){exempt_note}"
                             if exempt_note else
                             f"{len(files)} file(s) / {lines} changed line(s)")

    # Narrowings that changed WHAT could escalate — as opposed to the size measure, which the
    # exempt_note above covers — are appended to the reason itself, whatever branch won: a
    # suppressed critical match or a refined declaration must be visible on the one line every
    # consumer reads (org guide: no silent caps).
    tier_notes = []
    if crit_suppressed:
        tier_notes.append(f"{len(crit_suppressed)} critical match(es) on byte-identical derived "
                          "copies not counted — criticality follows the source")
    if decl_note:
        tier_notes.append(decl_note)
    if tier_notes:
        why += " [" + "; ".join(tier_notes) + "]"

    hc.say(f"review tier: {tier} — {why}")
    if not (rev["docs_only"] or rev["harness_layer"] or rev["critical"]):
        print("  warn: no review surfaces declared in .harness.json — the tier rests on size alone",
              file=sys.stderr)
    return emit_tail(root, cfg, warns, late)


if __name__ == "__main__":
    sys.exit(main())
