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
# ---------------------------------------------------------------------------------------------
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._/-]+$")


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
    return {"runner": runner, "script": script, "files": bool(raw.get("files", False))}


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
    cfg["review"] = {"docs_only": [], "harness_layer": [], "critical": []}
    # Retro surfaces. Free-string regexes like `review`: they select and report, and cannot name
    # an executable, so the closed-set rule that governs `gates` does not apply here.
    cfg["retro"] = {"source_scope": [], "dep_manifests": [], "migrations": []}

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

    for i, g in enumerate(raw.get("groups") or []):
        if not isinstance(g, dict) or not g.get("name") or not g.get("match"):
            warns.append(f"groups[{i}]: needs 'name' and 'match' — ignored")
            continue
        # Resolved BEFORE the gates: a script gate is validated against the form it composes to
        # under this prefix, so the prefix has to be known (and itself validated) first.
        g_strip = safe_path(g.get("strip_prefix", ""), f"groups[{g['name']}].strip_prefix", warns)
        gates: list = []
        for gate in g.get("gates") or []:
            if isinstance(gate, dict):
                sg = script_gate(gate, str(g["name"]), g_strip, root, warns)
                if sg:
                    gates.append(sg)
                continue
            gate = str(gate)
            if gate in GATES:
                gates.append(gate)
            else:
                warns.append(
                    f"groups[{g['name']}].gates: '{gate}' is not in the closed set "
                    f"({', '.join(sorted(GATES))}) — dropped"
                )
        cfg["groups"].append({
            "name": str(g["name"]),
            "match": str(g["match"]),
            "cwd": safe_cwd(g.get("cwd", ""), f"groups[{g['name']}].cwd", warns),
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


def changed_files(root: Path, rev_range: str | None, explicit: list[str]) -> tuple[list[str], dict]:
    """Return (files, provenance). Provenance is REPORTED by the caller, never dropped: a range
    that matches nothing while the working tree supplies the files is a vacuous pass — the run
    looks like it covered the range and did not."""
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
    worktree = git_lines(root, "diff", "--name-only", "HEAD")
    untracked = git_lines(root, "ls-files", "--others", "--exclude-standard")
    prov["worktree_files"] = len(worktree)
    prov["untracked_files"] = len(untracked)
    files.update(worktree)
    files.update(untracked)
    return sorted(files), prov


def print_scope(files: list[str], prov: dict) -> None:
    """One line naming where the file list came from — the only thing that makes an empty-range run
    distinguishable from a covered-range run."""
    if prov.get("source") == "explicit":
        if prov.get("range"):
            print("note: explicit files given — ignoring --range", file=sys.stderr)
        print(f"scope: {prov['explicit']} explicit file(s)")
        return
    parts = []
    if prov.get("range"):
        parts.append(f"range {prov['range']} -> {prov['range_files']}")
    parts.append(f"worktree {prov.get('worktree_files', 0)}")
    parts.append(f"untracked {prov.get('untracked_files', 0)}")
    print(f"scope: {' · '.join(parts)} = {len(files)} unique file(s)")
    if prov.get("range") and prov.get("range_files") == 0:
        print(
            f"warn: range {prov['range']} matched 0 file(s) — everything below rests on the "
            "WORKING TREE, not the range you asked for (vacuous-pass guard)",
            file=sys.stderr,
        )


def compose(parts: list[str], cwd: str) -> str:
    """`cd <cwd> && <cmd>`, or the command alone. `cwd` reaches a command position too, so it is
    held to the same token gate here — `safe_path` alone permits a space, `#` or `*`, each of
    which `sh -c` or an output parser would reinterpret. A refused cwd degrades to running from
    the repo root, which fails loudly on the stripped paths rather than running something else."""
    cmd = " ".join(parts)
    return f"cd {as_arg(cwd)} && {cmd}" if cwd and token_ok(cwd) else cmd


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
    return compose([*RUNNERS[cfg["runner"]], as_arg(rel)], cfg["cwd"])


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
    return compose(parts, group["cwd"])
