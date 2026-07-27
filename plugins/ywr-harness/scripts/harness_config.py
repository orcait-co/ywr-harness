"""Shared reader for `.harness.json` — the ONE place repo-specific harness values are parsed.

Imported by `verify_map.py` and `harness_gates.py`. There is deliberately one reader for one
schema: two readers of the same file is the divergence this plugin exists to prevent (ADR 0010),
and a validator that only some consumers apply is not a validator.

## Why selectors instead of command strings

Both consumers PRINT commands that a person or an agent then runs. `.harness.json` lives in the
working tree, so a cloned repository could otherwise supply the command that ends up executed.
Claude Code closed the same hole in its own surface: project-scope `pluginConfigs` entries are
ignored because those values "would flow into plugin hook commands" (plugins-reference). So:

- `runner` and every `gates` entry are SELECTORS from closed sets defined below. A value outside
  the set is refused, the set is named in the warning, and the default is substituted.
- Path values are refused if they contain a shell metacharacter or `..`.
- A refused value IS echoed in the warning — the reader has to see what was refused — but never
  reaches a printed command. Those are separate properties, asserted separately.
- Regexes are accepted as free strings: they select and report, and cannot name an executable.

Adding a stack means adding a template HERE, reviewed once, available to every consuming repo.
That is the whole mechanism by which this harness is stack-agnostic and still able to grow.
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
    for field in ("cwd", "strip_prefix", "ui_prefix"):
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
        gates: list[str] = []
        for gate in g.get("gates") or []:
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
            "cwd": safe_path(g.get("cwd", ""), f"groups[{g['name']}].cwd", warns),
            "strip_prefix": safe_path(g.get("strip_prefix", ""), f"groups[{g['name']}].strip_prefix", warns),
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
    cmd = " ".join(parts)
    return f"cd {cwd} && {cmd}" if cwd else cmd


def verify_command(cfg: dict, script: str) -> str:
    rel = script
    if cfg["strip_prefix"] and rel.startswith(cfg["strip_prefix"]):
        rel = rel[len(cfg["strip_prefix"]):]
    return compose([*RUNNERS[cfg["runner"]], rel], cfg["cwd"])


def gate_command(gate: str, group: dict, files: list[str]) -> str:
    spec = GATES[gate]
    parts = list(spec["cmd"])
    if spec["files"]:
        rel = []
        for f in files:
            r = f
            if group["strip_prefix"] and r.startswith(group["strip_prefix"]):
                r = r[len(group["strip_prefix"]):]
            rel.append(r)
        parts.extend(sorted(rel))
    return compose(parts, group["cwd"])
