"""Shared reader for `.harness.json` — the ONE place repo-specific harness values are parsed.

Imported by `verify_map.py` and `harness_gates.py`. There is deliberately one reader for one
schema: two readers of the same file is the divergence this plugin exists to prevent (ADR 0010),
and a validator that only some consumers apply is not a validator.

## Why selectors instead of command strings

Both consumers PRINT commands that a person or an agent then runs. `.harness.json` lives in the
working tree, so a cloned repository could otherwise supply the command that ends up executed.
Claude Code closed the same hole in its own surface: project-scope `pluginConfigs` entries are
ignored because those values "would flow into plugin hook commands" (plugins-reference). So:

- `runner` is a SELECTOR from the closed set below. A `gates` entry is either a selector from the
  closed `GATES` set, or a script gate `{runner, script, files}` (ADR 0024) whose runner is a
  selector from `RUNNERS` and whose script is a validated repo-relative path — the repo points at
  code it already carries; it never authors argv. A value outside a set is refused, the set is
  named in the warning, and the entry is dropped (for `verify.runner`, the default substituted).
- Path values are refused if they contain a shell metacharacter or `..`. Every token that reaches
  a command position — script paths from here AND from the docs index, plus the changed-file
  arguments of a file-scoped gate — additionally passes `token_ok()` in the form it will actually
  be composed (post `strip_prefix`), and `as_arg()` neutralizes a leading dash.
- A refused value IS echoed in the warning — the reader has to see what was refused — but never
  reaches a printed command. Those are separate properties, asserted separately.
- A file that cannot be an argument is EXCLUDED from the gate's arguments and reported as ungated:
  a filename is repo-supplied text too, and silence there would read as coverage.
- Regexes are accepted as free strings: they select and report, and cannot name an executable.

Adding a stack means adding a template HERE, reviewed once, available to every consuming repo.
That is the whole mechanism by which this harness is stack-agnostic and still able to grow. A
repo-specific entry point — a path no repo-independent selector could ever name — is a script
gate instead (ADR 0024).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# Encoding pin. Both consumers print `·` and `—`, and Python on Windows encodes stdout with the
# console codepage — so a caller decoding as UTF-8 (every harness selftest does) receives mojibake
# and any assertion or grep against the text silently stops matching. Measured on GitHub's
# windows-latest runner. Fixed here rather than at each call site because an agent reading the
# output is a caller too, and it cannot set an environment variable retroactively.
# ---------------------------------------------------------------------------------------------
def pin_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):  # not a reconfigurable text stream
            pass


# Closed set: how a verify script is executed.
RUNNERS: dict[str, list[str]] = {
    "python-uv": ["uv", "run", "python"],
    "python": ["python"],
    "poetry": ["poetry", "run", "python"],
    "node": ["node"],
    "pwsh": ["pwsh", "-NoProfile", "-File"],
}

# Closed set: deterministic gates that run BEFORE any LLM review.
#   files=True   the changed file list is appended — the gate is scoped to the slice.
#   files=False  whole-program (no per-file scoping). The caller must gate on failures in slice
#                files or newly introduced by the slice; pre-existing failures elsewhere are debt
#                to record, not work to absorb into the slice.
GATES: dict[str, dict] = {
    "ruff":         {"cmd": ["uv", "run", "ruff", "check"],                    "files": True},
    "ruff-format":  {"cmd": ["uv", "run", "ruff", "format", "--check"],        "files": True},
    "pytest":       {"cmd": ["uv", "run", "pytest", "-q"],                     "files": False},
    "pytest-nondb": {"cmd": ["uv", "run", "pytest", "-m", "not db", "-q"],     "files": False},
    "eslint":       {"cmd": ["npx", "eslint"],                                 "files": True},
    "prettier":     {"cmd": ["npx", "prettier", "--check"],                    "files": True},
    "tsc":          {"cmd": ["npx", "tsc", "--noEmit"],                        "files": False},
    "vitest":       {"cmd": ["npx", "vitest", "run"],                          "files": False},
    "cargo-clippy": {"cmd": ["cargo", "clippy", "--", "-D", "warnings"],       "files": False},
    "cargo-test":   {"cmd": ["cargo", "test"],                                 "files": False},
    "go-vet":       {"cmd": ["go", "vet", "./..."],                            "files": False},
    "go-test":      {"cmd": ["go", "test", "./..."],                           "files": False},
    "actionlint":   {"cmd": ["actionlint"],                                    "files": True},
}

UNSAFE = re.compile(r"[;&|`$<>\n\r\"']|\.\.")

DEFAULTS = {
    "index": "docs/index.json",
    "runner": "python",
    "cwd": "",
    "strip_prefix": "",
    "script_pattern": r"^.*/verify_.*\.py$",
    "product_scope": "",
    "ui_prefix": "",
    "handoff": "",
    "review_canon": "REVIEW.md",
    "retro_ignore_file": ".githooks/slice-retro-ignore",
}


def norm(path: str) -> str:
    return str(path).replace("\\", "/").strip()


def safe_path(value: str, field: str, warns: list[str]) -> str:
    v = norm(value)
    if v and UNSAFE.search(v):
        warns.append(f"{field}: rejected (shell metacharacter or '..' in a path value) — using default")
        return ""
    return v


# ---------------------------------------------------------------------------------------------
# The ONE gate every repo-supplied token passes before it can reach a printed command: script
# paths (from `.harness.json` AND from the docs index), and the changed-file arguments appended
# to a file-scoped gate. Composed commands are run by `sh -c` (the vendored CI and pre-commit
# both do), so a token must survive re-splitting byte-for-byte.
#
# An ALLOWLIST, not a blocklist. It excludes whitespace (sh re-splits the token), '#' (BOTH
# output parsers strip a trailing comment), glob characters (the CI runs `sh -c` without
# `set -f`), ':' (drive-absolute), and every shell metacharacter — including the ones nobody
# thought to list.
#
# WHERE the check happens is the load-bearing part, and getting it wrong is a measured defect,
# not a hypothetical: validating the DECLARED string while composing the STRIPPED one let
# `{"strip_prefix": "src/", "script": "src/-c"}` pass validation and reach argv as the bare flag
# `-c` — with `files: true`, the next token is a changed FILENAME, so `python -c <name>` executes
# that name as source. Found by adversarial review 2026-07-29, three independent lenses, before
# release. So: every token is validated in the form that ACTUALLY reaches argv, and `as_arg()`
# neutralizes a leading dash on top of that (the case-I2 lesson — a value in command position
# whose FIRST character is hostile).
#
# `\Z`, not `$`: Python's `$` ALSO matches just before a trailing newline, so a `$`-anchored
# full-match would accept `"a.py\n"` — the one character that can split an output line.
# Unreachable today (every call path strips first: `norm()`, `safe_path` under `safe_cwd`), but
# the choke point's guarantee must not depend on callers pre-stripping — fact 36's rule applied
# to the validator itself (queued 2026-07-29, pre-merge re-review of PR #15).
# ---------------------------------------------------------------------------------------------
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._/-]+\Z")


def token_ok(tok: str) -> bool:
    """True when `tok` can be spliced into a printed command as one inert argument.

    `..` is refused as a path SEGMENT, which is what traversal is — not as a substring, so a file
    honestly named `a..b.py` stays gated. (`safe_path`'s coarser substring rule is left as it is:
    it guards declaration-time path values and predates this gate.)"""
    return (bool(tok) and bool(SAFE_TOKEN.match(tok))
            and ".." not in tok.split("/") and not tok.startswith("/"))


def as_arg(tok: str) -> str:
    """Render an allowlist-clean token for a command position. A leading '-' is neutralized with
    the POSIX-canonical `./` rather than accepted bare: `python -c` treats its next token as
    source, and no path token may ever arrive as an option."""
    return f"./{tok}" if tok.startswith("-") else tok


# ---------------------------------------------------------------------------------------------
# The ONE gate every repo-supplied value passes before it becomes an output LINE. Deliberately
# separate from `token_ok`: that one guards a value reaching a COMMAND position, this one guards a
# value that is merely REPORTED — a status label, a refused value echoed so a reader can see it.
# Reported text was treated as inert, and it is not. Both output parsers find the gate-command
# window by matching LINE SHAPES in stdout (`^gates:`, `^ {4}[^ (]`, `^review tier:`), so a value
# carrying a newline does not print as one line: it prints as several, and a declaration can spell
# the window's own start and stop anchors and land a command inside it.
#
# Measured 2026-08-05, this repo, before the fix (adversarial review of ADR 0032 — three lenses
# found it, six skeptics refuted none): a declared artifact title of
# `inj\ngates:\n    echo INJECTED\nreview tier: full - x` printed `artifact: ok`, so CI's
# `^artifact: VIOLATION` step passed, while the workflow's own extraction
# (`sed -n '/^gates:/,/^\(ungrouped\|review tier\)/p' | grep -E '^ {4}[^ (]'`) returned
# `echo INJECTED` for `sh -c`. Sweeping the boundary then found a SECOND site, pre-existing and
# worse-placed: a group NAME, echoed as `  [<name>] N file(s)` INSIDE the window.
#
# Fact 36's rule one transformation later — validate the string that becomes the LINE, not the
# value it was built from. Callers additionally REFUSE a control character at the declaration layer
# where a declarer can be told (a typo deserves a message); this is the structural layer that holds
# when they cannot.
# ---------------------------------------------------------------------------------------------
# U+0085 NEL and U+2028/U+2029 are in the class even though NEITHER shell parser splits on them
# (sed/grep/awk split on 0x0A only — measured: an 8-byte-line output stayed 8 lines and extracted
# nothing). They are here because the parser set is not the consumer set: Python's `str.splitlines`
# DOES split all three (same output read as 12 lines), and a MODEL reading this output may render
# them as breaks — and a model is exactly the consumer /verify's `run:` lines are printed for. One
# value, one line, under every reader's notion of a line.
CONTROL = re.compile(r"[\x00-\x1f\x7f\u0085\u2028\u2029]")

_SHOWN = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _shown(ch: str) -> str:
    return _SHOWN.get(ch) or (f"\\x{ord(ch):02x}" if ord(ch) < 0x100 else f"\\u{ord(ch):04x}")


def has_control(value: str) -> bool:
    """True when repo-supplied text carries a character some reader treats as a line break — C0,
    DEL, or one of the three Unicode breaks named above."""
    return bool(CONTROL.search(str(value)))


def one_line(value: str) -> str:
    """Render repo-supplied text so it can only ever occupy ONE output line. The characters become
    VISIBLE escapes rather than being dropped: a reader diagnosing a refusal has to see what was
    declared, and a silently stripped newline reads as a value nobody wrote."""
    return CONTROL.sub(lambda m: _shown(m.group()), str(value))


def say(line: str = "") -> None:
    """The single stdout exit for the two consumers whose output has a LINE-SHAPE contract (the gate
    emitter, read by the CI/pre-commit window parsers; the verify mapper, read by a model told to
    run its `run:` lines).

    Not a convenience wrapper. Per-call-site escaping was MEASURED to fail here: the first sweep of
    this boundary wrapped the sites it could see, and the bounded re-review then found two more —
    one of which (critical-surface filenames in the review-tier line) reproduced the injection end
    to end, because a forged `gates:` line RE-ARMS `sed`'s range even after the real window closed.
    A single exit makes forgetting a call site impossible instead of unlikely, which is the whole
    difference between a rule and a habit.

    Our own multi-line literals must call `print` directly and sanitize the repo-supplied part
    themselves — deliberately the awkward path, so multi-line output is a decision, never a
    default."""
    print(one_line(line))


def warn(msg: str) -> None:
    """The single stderr exit. No machine parser reads this channel (CI captures stdout through
    `tee`; the pre-commit hook captures stdout through command substitution) — but it is a human
    DISPLAY, and a raw ESC sequence in a refused value would repaint the committer's terminal
    during `git commit`, able to overwrite the hook's own preceding line. Escaped, a refused value
    is still fully legible, which is the property that made echoing it correct in the first
    place."""
    print(f"warn: {one_line(msg)}", file=sys.stderr)


def strip_group_prefix(path: str, strip_prefix: str) -> str:
    return path[len(strip_prefix):] if strip_prefix and path.startswith(strip_prefix) else path


def safe_cwd(value: str, field: str, warns: list[str]) -> str:
    """A `cwd` is composed as `cd <cwd> && …`, so it is a command-position token and needs the same
    allowlist as a path argument — `safe_path` alone permits a space, `#` or `*`. Refused values
    degrade to the repo root, reported: the command then fails on its stripped paths instead of
    running in a directory nobody named."""
    v = safe_path(value, field, warns)
    if v and not token_ok(v):
        warns.append(f"{field}: '{v}' refused as a working directory (must be a repo-relative path "
                     "of [A-Za-z0-9._/-], no '..') — commands will be printed WITHOUT a `cd`, so "
                     "they run from the repo root")
        return ""
    return v


def script_gate(raw: dict, group: str, strip_prefix: str, root: Path,
                warns: list[str]) -> dict | None:
    """Validate a script gate `{runner, script, files}` (ADR 0024). The runner stays a closed-set
    choice; the script is a repo-relative path. BOTH forms are validated — as declared, and as it
    will actually be composed after the group's `strip_prefix` — because the second is the one
    that becomes argv. Returns None (and warns) when it cannot be composed safely; a refused
    value is echoed in the warning and never composed."""
    field = f"groups[{group}].gates"
    # An unknown key is warned about, never silently dropped — a member declaring `"args":
    # "--fast"` must get a signal that no argument field exists (that silence was the exact shape
    # ADR 0024's follow-up trigger named; queued 2026-07-29). `//`-prefixed keys stay the comment
    # convention, as everywhere else in the schema. The sweep runs BEFORE the runner/script
    # checks on purpose: a gate dropped for a bad runner still reports its unknown keys, and the
    # two warnings TOGETHER are what diagnose a typo'd key name (`"runer"` → unknown key 'runer'
    # + runner '' not in the closed set).
    for key in raw:
        if key not in ("runner", "script", "files") and not str(key).startswith("//"):
            warns.append(f"{field}: unknown script-gate key '{key}' ignored "
                         "(known: runner, script, files)")
    runner = str(raw.get("runner") or "")
    if runner not in RUNNERS:
        warns.append(
            f"{field}: script-gate runner '{runner}' is not in the closed set "
            f"({', '.join(sorted(RUNNERS))}) — dropped"
        )
        return None
    script = norm(str(raw.get("script") or ""))
    effective = strip_group_prefix(script, strip_prefix)
    if not token_ok(script) or script.startswith("-"):
        warns.append(
            f"{field}: script-gate path '{script}' refused (a repo-relative path of "
            "[A-Za-z0-9._/-] only, no '..', no leading '/' or '-') — dropped"
        )
        return None
    if not token_ok(effective) or effective.startswith("-"):
        warns.append(
            f"{field}: script-gate path '{script}' refused — under strip_prefix "
            f"'{strip_prefix}' it composes to '{effective}', which is not a usable path in a "
            "command position (a leading '-' would be read as an option to the runner) — dropped"
        )
        return None
    if not (root / script).is_file():
        # Kept, not dropped: dropping would let a typo read as coverage, while the emitted
        # command fails loudly at run time and this warning names the path at emit time.
        warns.append(f"{field}: script-gate path '{script}' does not exist — kept; the emitted "
                     "command will fail until it does")
    files = raw.get("files", False)
    if not isinstance(files, bool):
        # `bool("false")` is True — a JSON string here would silently INVERT the declared intent
        # and append the changed-file list to a script that never asked for one. The default
        # (False, whole-program) is also the conservative direction: the script runs exactly as
        # it would with the key absent.
        warns.append(f"{field}: script-gate 'files' must be a JSON boolean (true/false), got "
                     f"'{files}' — treated as false (whole-program)")
        files = False
    return {"runner": runner, "script": script, "files": files}


def compile_re(pattern: str, field: str, warns: list[str]) -> re.Pattern | None:
    if not pattern:
        return None
    try:
        return re.compile(pattern)
    except re.error as e:
        warns.append(f"{field}: not a valid regex ({e}) — ignored")
        return None


def find_repo_root(start: Path) -> Path:
    """Walk upward for .harness.json, then for .git. Falls back to `start`: both consumers are
    advisory, so a repo with neither marker still works on defaults rather than failing."""
    for marker in (".harness.json", ".git"):
        cur = start.resolve()
        for candidate in (cur, *cur.parents):
            if (candidate / marker).exists():
                return candidate
    return start.resolve()


def load(root: Path) -> tuple[dict, list[str]]:
    """Return (config, warnings). Warnings are RETURNED, never printed here — the caller decides
    where they go, and a silently swallowed warning about a refused value would look exactly like
    a good configuration."""
    warns: list[str] = []
    cfg = dict(DEFAULTS)
    cfg["groups"] = []
    cfg["review"] = {"docs_only": [], "harness_layer": [], "critical": [], "derived": []}
    # Retro surfaces. Free-string regexes like `review`: they select and report, and cannot name
    # an executable, so the closed-set rule that governs `gates` does not apply here.
    cfg["retro"] = {"source_scope": [], "dep_manifests": [], "migrations": []}
    # Declared claude.ai Artifacts (ADR 0032). Parsed here, CHECKED by the gate emitter: the
    # README must carry each declared url, each declared title must start with the repo name.
    # Items are kept raw — per-item validation happens at check time so a malformed entry can
    # fail the check loudly instead of being dropped into silence at load time. `malformed`
    # carries a section-level shape error for the same reason: a declaration that cannot be
    # checked must never read as enforcement.
    cfg["artifacts"] = {"readme": "README.md", "items": [], "malformed": ""}

    path = root / ".harness.json"
    if not path.exists():
        warns.append(".harness.json not found — using defaults (selection and gates will be broad)")
        return cfg, warns
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        warns.append(f".harness.json unreadable ({type(e).__name__}) — using defaults")
        return cfg, warns

    docs = raw.get("docs") or {}
    if docs.get("index"):
        cfg["index"] = safe_path(docs["index"], "docs.index", warns) or DEFAULTS["index"]

    ver = raw.get("verify") or {}
    runner = str(ver.get("runner") or DEFAULTS["runner"])
    if runner not in RUNNERS:
        warns.append(
            f"verify.runner '{runner}' is not in the closed set "
            f"({', '.join(sorted(RUNNERS))}) — using '{DEFAULTS['runner']}'"
        )
        runner = DEFAULTS["runner"]
    cfg["runner"] = runner
    if ver.get("cwd"):
        cfg["cwd"] = safe_cwd(ver["cwd"], "verify.cwd", warns)
    for field in ("strip_prefix", "ui_prefix"):
        if ver.get(field):
            cfg[field] = safe_path(ver[field], f"verify.{field}", warns)
    for field in ("script_pattern", "product_scope"):
        if ver.get(field):
            cfg[field] = str(ver[field])

    if raw.get("handoff"):
        cfg["handoff"] = safe_path(raw["handoff"], "handoff", warns)

    rev = raw.get("review") or {}
    if rev.get("canon"):
        cfg["review_canon"] = safe_path(rev["canon"], "review.canon", warns) or DEFAULTS["review_canon"]
    for key in ("docs_only", "harness_layer", "critical"):
        val = rev.get(key)
        if isinstance(val, list):
            cfg["review"][key] = [str(p) for p in val]
        elif val:
            warns.append(f"review.{key}: expected a list of regexes — ignored")

    # Derived-copy mappings (ADR 0037). PATH PREFIXES, not regexes: the copy→source mapping is
    # computed by prefix swap, so each prefix must end with '/' (a bare prefix could match a
    # sibling directory mid-segment) and pass the same token allowlist as any path value. These
    # never reach a command position — the emitter only reads bytes at the mapped paths — but a
    # traversal segment must still be refused: the mapped path is opened relative to the root.
    der = rev.get("derived")
    if isinstance(der, list):
        for i, d in enumerate(der):
            if not isinstance(d, dict):
                warns.append(f"review.derived[{i}]: expected an object with 'source' and 'copies' — ignored")
                continue
            for key in d:
                if key not in ("source", "copies") and not str(key).startswith("//"):
                    warns.append(f"review.derived[{i}]: unknown key '{key}' ignored (known: source, copies)")
            src = norm(str(d.get("source") or ""))
            raw_copies = d.get("copies")
            copies = [norm(str(c)) for c in raw_copies] if isinstance(raw_copies, list) else []
            bad = [p for p in [src, *copies] if p and not (token_ok(p) and p.endswith("/"))]
            if not src or not copies or any(not c for c in copies) or bad:
                shown = f" — refused: {', '.join(one_line(b) for b in bad)}" if bad else ""
                warns.append(f"review.derived[{i}]: 'source' and 'copies' must be path PREFIXES "
                             "ending in '/' ([A-Za-z0-9._/-] only, no '..', no leading '/')"
                             f"{shown} — entry ignored")
                continue
            cfg["review"]["derived"].append({"source": src, "copies": copies})
    elif der:
        warns.append("review.derived: expected a list of {source, copies} mappings — ignored")

    ret = raw.get("retro") or {}
    if ret.get("ignore_file"):
        cfg["retro_ignore_file"] = (
            safe_path(ret["ignore_file"], "retro.ignore_file", warns) or DEFAULTS["retro_ignore_file"]
        )
    for key in ("source_scope", "dep_manifests", "migrations"):
        val = ret.get(key)
        if isinstance(val, list):
            cfg["retro"][key] = [str(p) for p in val]
        elif val:
            warns.append(f"retro.{key}: expected a list of regexes — ignored")

    art = raw.get("artifacts")
    if isinstance(art, dict):
        if art.get("readme"):
            cfg["artifacts"]["readme"] = (
                safe_path(art["readme"], "artifacts.readme", warns) or "README.md")
        items = art.get("items")
        if isinstance(items, list):
            cfg["artifacts"]["items"] = list(items)
        elif items is not None:
            cfg["artifacts"]["malformed"] = "'items' must be a list of {url, title} objects"
        for key in art:
            if key not in ("readme", "items") and not str(key).startswith("//"):
                warns.append(f"artifacts: unknown key '{key}' ignored (known: readme, items)")
    elif art is not None:
        cfg["artifacts"]["malformed"] = "expected an object with 'readme' and 'items'"

    for i, g in enumerate(raw.get("groups") or []):
        if not isinstance(g, dict) or not g.get("name") or not g.get("match"):
            warns.append(f"groups[{i}]: needs 'name' and 'match' — ignored")
            continue
        # The name is a LABEL, echoed by the emitter as `  [<name>] N file(s)` — a line inside the
        # gate-command window both output parsers execute from. Sanitized HERE, once, so every
        # downstream use (field labels, the grouping key, the printed label) is the safe form: a
        # value that never exists in its raw shape after load cannot be echoed raw by a later
        # caller. A control character is reported, never silently swallowed.
        name = one_line(str(g["name"]))
        if has_control(str(g["name"])):
            warns.append(f"groups[{i}]: control character(s) in the group name were escaped for "
                         f"display ('{name}') — a group name is echoed inside the gate-command "
                         "window, so a raw newline there would forge a gate command")
        # Resolved BEFORE the gates: a script gate is validated against the form it composes to
        # under this prefix, so the prefix has to be known (and itself validated) first.
        g_strip = safe_path(g.get("strip_prefix", ""), f"groups[{name}].strip_prefix", warns)
        gates: list = []
        for gate in g.get("gates") or []:
            if isinstance(gate, dict):
                sg = script_gate(gate, name, g_strip, root, warns)
                if sg:
                    gates.append(sg)
                continue
            gate = str(gate)
            if gate in GATES:
                gates.append(gate)
            else:
                warns.append(
                    f"groups[{name}].gates: '{gate}' is not in the closed set "
                    f"({', '.join(sorted(GATES))}) — dropped"
                )
        cfg["groups"].append({
            "name": name,
            "match": str(g["match"]),
            "cwd": safe_cwd(g.get("cwd", ""), f"groups[{name}].cwd", warns),
            "strip_prefix": g_strip,
            "gates": gates,
        })
    if raw.get("groups") and not cfg["groups"]:
        warns.append("groups: every entry was rejected — no deterministic gate will be emitted")
    return cfg, warns


# ---------------------------------------------------------------------------------------------
# Scope resolution. Lives here, not in either consumer: both /verify and the gate emitter must
# answer "which files is this slice" the SAME way, and two implementations of that question would
# let a slice pass one gate on a different file set than the other saw.
# ---------------------------------------------------------------------------------------------
def git_lines(root: Path, *args: str) -> list[str]:
    import subprocess
    out = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    return [norm(line) for line in out.splitlines() if line.strip()]


def changed_files(root: Path, rev_range: str | None, explicit: list[str],
                  all_files: bool = False) -> tuple[list[str], dict]:
    """Return (files, provenance). Provenance is REPORTED by the caller, never dropped: a range
    that matches nothing while the working tree supplies the files is a vacuous pass — the run
    looks like it covered the range and did not.

    `all_files` is the full-tree audit scope (ADR 0041): git ls-files + untracked. It exists for
    CI's push runs, where the worktree is a fresh checkout and every diff-shaped scope is empty
    by construction — partition and gate coverage are TREE properties there, not diff properties."""
    import subprocess
    if all_files:
        tracked = git_lines(root, "ls-files")
        untracked = git_lines(root, "ls-files", "--others", "--exclude-standard")
        files = sorted(set(tracked) | set(untracked))
        return files, {"source": "all", "tracked_files": len(tracked),
                       "untracked_files": len(untracked)}
    if explicit:
        files = [norm(p) for p in explicit]
        return files, {"source": "explicit", "explicit": len(files), "range": rev_range}
    prov: dict = {"source": "git", "range": rev_range, "range_files": None}
    files: set[str] = set()
    if rev_range:
        ranged = git_lines(root, "diff", "--name-only", rev_range)
        prov["range_files"] = len(ranged)
        files.update(ranged)
    # Current state always counts: staged+unstaged vs HEAD, plus untracked. `git diff` never lists
    # untracked files, and a new file must surface too.
    try:
        worktree = git_lines(root, "diff", "--name-only", "HEAD")
    except subprocess.CalledProcessError:
        # An unborn HEAD (no commit yet — a freshly scaffolded repo before its first commit) is a
        # NORMAL state, not the ADR 0041 fail-loud class (force-pushed base, stale fetch): letting
        # it escalate fired `scope: FAILED` on `git init && git add` (review 2026-08-10, high).
        # Verify which failure this is: with HEAD genuinely absent, the honest worktree scope is
        # staged (index vs the empty tree) plus unstaged (index vs worktree), both of which git
        # answers without HEAD. Any other diff failure re-raises and stays loud.
        probe = subprocess.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"],
                               cwd=root, capture_output=True)
        if probe.returncode == 0:
            raise
        worktree = sorted(set(git_lines(root, "diff", "--name-only", "--cached"))
                          | set(git_lines(root, "diff", "--name-only")))
        prov["unborn_head"] = True
    untracked = git_lines(root, "ls-files", "--others", "--exclude-standard")
    prov["worktree_files"] = len(worktree)
    prov["untracked_files"] = len(untracked)
    files.update(worktree)
    files.update(untracked)
    return sorted(files), prov


def print_scope(files: list[str], prov: dict) -> None:
    """One line naming where the file list came from — the only thing that makes an empty-range run
    distinguishable from a covered-range run."""
    if prov.get("source") == "all":
        say(f"scope: full tree — tracked {prov.get('tracked_files', 0)} · "
            f"untracked {prov.get('untracked_files', 0)} = {len(files)} unique file(s) (--all)")
        return
    if prov.get("source") == "explicit":
        if prov.get("range"):
            print("note: explicit files given — ignoring --range", file=sys.stderr)
        say(f"scope: {prov['explicit']} explicit file(s)")
        return
    parts = []
    if prov.get("range"):
        parts.append(f"range {prov['range']} -> {prov['range_files']}")
    parts.append(f"worktree {prov.get('worktree_files', 0)}")
    parts.append(f"untracked {prov.get('untracked_files', 0)}")
    say(f"scope: {' · '.join(parts)} = {len(files)} unique file(s)")
    if prov.get("unborn_head"):
        warn("no commit yet (unborn HEAD) — the worktree scope is staged+unstaged vs the "
             "empty tree; this is a report, not a failure (ADR 0041's loud exit is for a "
             "scope git could not answer at all)")
    if prov.get("range") and prov.get("range_files") == 0:
        warn(f"range {prov['range']} matched 0 file(s) — everything below rests on the "
             "WORKING TREE, not the range you asked for (vacuous-pass guard)")


def compose(parts: list[str], cwd: str, warns: list[str] | None = None) -> str:
    """`cd <cwd> && <cmd>`, or the command alone. `cwd` reaches a command position too, so it is
    held to the same token gate here — `safe_path` alone permits a space, `#` or `*`, each of
    which `sh -c` or an output parser would reinterpret. A refused cwd degrades to running from
    the repo root, which fails loudly on the stripped paths rather than running something else.

    `warns` is threaded for the same reason `gate_command` threads one: this second-layer refusal
    is unreachable through `load()` today (`safe_cwd` already scrubbed the value), and a drop
    with no warns channel is a silent drop waiting for a refactor (queued 2026-07-29)."""
    cmd = " ".join(parts)
    if cwd and token_ok(cwd):
        return f"cd {as_arg(cwd)} && {cmd}"
    if cwd and warns is not None:
        warns.append(f"cwd '{cwd}' refused at composition — the command was printed WITHOUT a "
                     "`cd`, so it runs from the repo root")
    return cmd


def verify_command(cfg: dict, script: str, warns: list[str] | None = None) -> str:
    """Compose the command that runs one spec-registered verify script.

    The script path comes from the docs index — generated from spec frontmatter, so it is
    repo-supplied text in the working tree, exactly like a `.harness.json` value. It therefore
    passes the same token gate, checked on the POST-strip_prefix form that actually becomes argv.
    A refused path yields a parenthetical that is not a command and does NOT repeat the value:
    the value belongs in the warning, never in a command position (ADR 0012)."""
    rel = strip_group_prefix(norm(script), cfg["strip_prefix"])
    if not token_ok(rel):
        if warns is not None:
            warns.append(f"verify script path '{script}' refused — under strip_prefix "
                         f"'{cfg['strip_prefix']}' it composes to '{rel}', which is not a safe "
                         "command argument; no run line was composed for it")
        return "(refused — unsafe verify script path; see warning)"
    return compose([*RUNNERS[cfg["runner"]], as_arg(rel)], cfg["cwd"], warns)


def gate_is_scoped(gate) -> bool:
    """True when the gate takes the changed-file list; False for whole-program. One reader for
    both gate forms so the emitter never branches on shape itself."""
    return bool(GATES[gate]["files"] if isinstance(gate, str) else gate["files"])


def unsafe_files(group: dict, files: list[str]) -> list[str]:
    """Changed files that cannot be passed to a gate command as arguments, in their post-strip
    form. Reported by the caller so the coverage loss is stated rather than silent: a filename is
    repo-supplied text too — `sh -c` would re-split one containing a space, and both output
    parsers truncate one containing '#'."""
    return sorted(f for f in files if not token_ok(strip_group_prefix(f, group["strip_prefix"])))


def gate_command(gate, group: dict, files: list[str], warns: list[str] | None = None) -> str:
    """Compose one gate command. `gate` is a closed-set selector string or a validated script-gate
    dict from `script_gate()` — a raw dict from JSON must never reach here.

    Every path token is re-checked here even though the declaration was validated at load time.
    That is deliberate duplication: a validator only some call sites apply is not a validator, and
    this is the last point before a string becomes a command.

    `warns` is threaded for the same reason `verify_command` threads one. Today the refusal below
    is unreachable through `load()` (it derives `strip_prefix` from the same group dict), so this
    is the channel that keeps the SECOND layer honest if a future caller ever makes it fire: a
    branch whose message says "see warning" while writing to no warning list is a silent drop
    waiting for a refactor."""
    if isinstance(gate, str):
        parts = list(GATES[gate]["cmd"])
    else:
        # Mirrors verify_command: strip_prefix applies to the script path too, so a group that
        # runs from `cwd` addresses its script the same way it addresses its files.
        script = strip_group_prefix(gate["script"], group["strip_prefix"])
        if not token_ok(script):
            if warns is not None:
                warns.append(
                    f"groups[{group['name']}].gates: script-gate path '{gate['script']}' refused "
                    f"at composition — under strip_prefix '{group['strip_prefix']}' it becomes "
                    f"'{script}', which is not a safe command argument; NO command was composed"
                )
            return "(refused — unsafe script-gate path; see warning)"
        parts = [*RUNNERS[gate["runner"]], as_arg(script)]
    if gate_is_scoped(gate):
        rel = sorted(r for r in (strip_group_prefix(f, group["strip_prefix"]) for f in files)
                     if token_ok(r))
        if not rel:
            # Emitting the bare command here would be worse than emitting nothing: a file-scoped
            # gate with no file list is a WHOLE-TREE run (`ruff check` lints everything), so a
            # group whose every filename was excluded would silently escalate its own scope.
            return "(skipped — none of this group's changed files can be a command argument)"
        parts.extend(as_arg(r) for r in rel)
    return compose(parts, group["cwd"], warns)
