"""Failing-then-passing proof for each high the review names (ADR 0169). Backend for /slice-close stage 2.

A fix-check leg READS a fix (ADR 0090); nothing in that leg runs the finding's scenario. This script
runs it. The closer runs a command that shows the defect BEFORE editing the fix, and the same command
after it. Each run is recorded with the exit code this script observed, the worktree snapshots taken
just before and just after it (the `--tree` identity, ADR 0105) and HEAD. `check` then passes a key only on that
evidence, so the proof is not the closer's own line in the close record — ADR 0105's "input, never
proof" applies to such a line.

The closer does not choose which keys `check` covers. The review's digest names them (`high_ids`), and
`check` takes that line verbatim; extra keys only add to the set. A waiver never makes `check` green:
it exits 3, and the close waits for the owner to accept each waived key in the owner-typed
/slice-close. Without that, leaving out one key or writing one reason was enough to pass.

Usage:
  python fix_proof.py run <key> -- <command> [args...]   # run at the repo root, record the exit code
  python fix_proof.py waive <key> --reason "<text>"      # no command can show this fix; say why
  python fix_proof.py check --digest "<digest>" [<key> ...]
      # 0 all proven · 1 a key has no proof · 3 only waivers left, each needs the owner
  python fix_proof.py --repo <dir> ...

A key is PROVEN when an exit-0 run has the CURRENT tree and an EARLIER run of the same argv exited
non-zero at another tree; otherwise a waiver marks it WAIVED (the owner's call); otherwise it is MISSING. Only a
run that left the tree as it found it counts: a command that writes a non-ignored file (a snapshot
test, codegen, a formatter) would otherwise move the tree itself and pass as its own fix. Any non-zero
exit is a failing half, because test tools signal failure with different codes (cargo test's 101); a
usage error is non-zero too, so the PROVEN line prints the failing code for the record's reader. Only
records at the current HEAD count, and each id carries the finding's fingerprint, so neither an
earlier slice nor a re-review can lend a proof to another finding. The journal lives under
`git rev-parse --git-path` (per worktree, never tracked) and is append-only.

Plugin-only on purpose: the scaffold does not vendor it (ADR 0169 option E — the emitter executes
nothing, and a consumer's CI has no use for a session step).
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

import harness_config as hc

hc.pin_utf8()

JOURNAL = "ywr-harness/fix-proof.jsonl"
# The workflow's ids are `F<n>-<fingerprint>` and so on; the shape is all the script enforces of a key.
KEY_RX = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,31}")
# The digest field the adversarial-review workflow prints (ADR 0169): `none`, or the count and then the
# ids of the in-scope confirmed highs and of the rejected highs that not every vote refuted.
ID = r"[FR][0-9]+-[0-9a-f]{8}"
HIGH_IDS_RX = re.compile(rf"(?:^| · )high_ids (?:none|([0-9]+): ({ID}(?:,{ID})*))(?= · |$)")
SHORT = 12


def shown(argv: list[str]) -> str:
    return shlex.join(argv)


def journal_path(root: Path) -> Path:
    return root / hc.git_run(root, "rev-parse", "--git-path", JOURNAL).strip()


def read_records(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out = []
    # `replace`: torn bytes become a line that fails json.loads and is named below, never a traceback.
    for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            rec = None
        if not isinstance(rec, dict) or not isinstance(rec.get("key"), str):
            # A torn or hand-edited line proves nothing; say so instead of reading it as absent.
            hc.warn(f"{path.name}:{n} is not a proof record — ignored")
            continue
        out.append(rec)
    return out


def append(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(rec, ensure_ascii=True) + "\n")


def stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def verdict(recs: list[dict], key: str, tree: str) -> tuple[str, str]:
    """(PROVEN | WAIVED | MISSING, detail) for one key over the records already filtered to HEAD."""
    mine = [r for r in recs if r.get("key") == key]
    # A run counts only when the command left the tree as it found it (`tree_after`).
    runs = [r for r in mine if r.get("kind") == "run" and isinstance(r.get("argv"), list)
            and r.get("tree_after") == r.get("tree")]
    for p in range(len(runs) - 1, -1, -1):
        ok = runs[p]
        if ok.get("exit") != 0 or ok.get("tree") != tree:
            continue
        for bad in reversed(runs[:p]):
            if bad.get("argv") == ok["argv"] and bad.get("exit") not in (0, None) and bad.get("tree") != tree:
                return "PROVEN", (f"exit {bad.get('exit')} at tree {str(bad.get('tree'))[:SHORT]}, exit 0 at tree "
                                  f"{tree[:SHORT]} (current) · {shown(ok['argv'])}")
    waivers = [r for r in mine if r.get("kind") == "waive" and isinstance(r.get("reason"), str)]
    if waivers:
        return "WAIVED", waivers[-1]["reason"]
    if not mine:
        return "MISSING", "no run and no waiver at this HEAD"
    if not runs:
        return "MISSING", ("every run changed the tree while it ran — ignore or remove what the command "
                           "writes, then run it again")
    if not any(r.get("exit") == 0 and r.get("tree") == tree for r in runs):
        return "MISSING", (f"no exit-0 run at the current tree {tree[:SHORT]} — run the same command "
                           "again after the last edit")
    return "MISSING", ("no earlier failing run of the same argv at another tree — a command that "
                       "passes before the fix proves nothing")


def main() -> int:
    try:
        return proof_main()
    except OSError as e:
        # The journal could not be read or written: no record is a missing proof, never a traceback
        # a reader might retry or paraphrase as a pass.
        hc.say(f"fix proof: FAILED — journal I/O: {e} (ADR 0169)")
        return 2


def proof_main() -> int:
    ap = argparse.ArgumentParser(description="Record and check failing-then-passing runs for fixed findings (ADR 0169).")
    ap.add_argument("--repo", dest="repo", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_run = sub.add_parser("run", help="run a command at the repo root and record its exit code")
    p_run.add_argument("key")
    p_run.add_argument("command", nargs=argparse.REMAINDER)
    p_waive = sub.add_parser("waive", help="record why no command can show this fix")
    p_waive.add_argument("key")
    p_waive.add_argument("--reason", required=True)
    p_check = sub.add_parser("check", help="0 all proven, 1 a key unproven, 3 waivers need the owner")
    p_check.add_argument("--digest", required=True, help="the review's digest line, verbatim")
    p_check.add_argument("keys", nargs="*", help="keys beyond the digest's high_ids, such as a fixed O<n>")
    args = ap.parse_args()

    if args.cmd == "check":
        m = HIGH_IDS_RX.search(args.digest)
        if not m:
            hc.say("fix proof: FAILED — the digest carries no `high_ids` field. Pass the review's digest line "
                   "verbatim; a workflow older than ADR 0169 prints none, so this close cannot be checked.")
            return 2
        required = m.group(2).split(",") if m.group(2) else []
        if m.group(1) and int(m.group(1)) != len(required):
            # A paste cut short after a comma would still parse; the count is what catches it.
            hc.say(f"fix proof: FAILED — high_ids counts {m.group(1)} but lists {len(required)}. Pass the "
                   "digest line whole.")
            return 2
        keys = list(dict.fromkeys(required + args.keys))
    else:
        keys = [args.key]
    bad_keys = [k for k in keys if not KEY_RX.fullmatch(k)]
    if bad_keys:
        hc.say(f"fix proof: FAILED — not a key: {', '.join(bad_keys)} (letter first, then up to 31 of "
               "A-Z a-z 0-9 . _ -)")
        return 2
    # Every refusal that needs no git comes before the snapshot: a snapshot is several git calls.
    if args.cmd == "run":
        argv = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not argv:
            hc.say("fix proof: FAILED — no command after the key (run <key> -- <command> [args...])")
            return 2
    if args.cmd == "waive":
        reason = args.reason.strip()
        if not reason or hc.has_control(reason):
            hc.say(f"proof {args.key}: FAILED — a waiver needs a one-line reason")
            return 2
    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    try:
        path = journal_path(root)
        if args.cmd == "waive":
            # A waiver binds to HEAD only (verdict never reads its tree), so it skips the snapshot.
            head = hc.git_run(root, "rev-parse", "--verify", "HEAD").strip()
        else:
            tree, head = hc.worktree_snapshot(root)
    except (subprocess.CalledProcessError, OSError) as e:
        if isinstance(e, subprocess.CalledProcessError):
            print(f"git failed: {(e.stderr or '').strip()}", file=sys.stderr)
        else:
            print(f"snapshot failed: {e}", file=sys.stderr)
        hc.say("fix proof: FAILED — no git worktree snapshot; nothing was run or checked (ADR 0169).")
        return 2

    if args.cmd == "run":
        try:
            # No shell and no stdin: the argv the record names is exactly what ran, and a prompt
            # cannot hang the close. No timeout: the session's own tool timeout bounds a hang.
            code = subprocess.run(argv, cwd=root, stdin=subprocess.DEVNULL).returncode
        except OSError as e:
            hc.say(f"proof {args.key}: FAILED — the command could not start: {e}. Give an executable; "
                   "wrap a shell line in `pwsh -NoProfile -Command` or `sh -c`. Nothing was recorded.")
            return 2
        try:
            after, head_after = hc.worktree_snapshot(root)
        except (subprocess.CalledProcessError, OSError):
            hc.say(f"proof {args.key}: FAILED — no snapshot after the run; nothing was recorded (ADR 0169).")
            return 2
        prior = [r for r in read_records(path) if r.get("head") == head]
        append(path, {"key": args.key, "kind": "run", "argv": argv, "exit": code, "tree": tree,
                      "tree_after": after if head_after == head else None, "head": head, "at": stamp()})
        hc.say(f"proof {args.key}: run exit {code} at tree {tree[:SHORT]} · {shown(argv)}")
        if after != tree or head_after != head:
            hc.say(f"proof {args.key}: note — the command changed the tree (now {after[:SHORT]}), so this "
                   "run cannot count; ignore or remove what it writes, then run it again")
        elif code not in (0, 1):
            # Advisory only: cargo test fails with 101, but a missing test file fails too.
            hc.say(f"proof {args.key}: note — exit {code}: make sure the test failed, not its invocation "
                   "(a missing file, a bad flag); the check prints this code")
        elif code == 0 and not any(r.get("key") == args.key and r.get("kind") == "run" and r.get("argv") == argv
                                   and r.get("exit") not in (0, None) and r.get("tree_after") == r.get("tree")
                                   for r in prior):
            hc.say(f"proof {args.key}: note — no failing run of this argv at this HEAD yet; the proof "
                   "needs one from before the fix")
        return 0

    if args.cmd == "waive":
        append(path, {"key": args.key, "kind": "waive", "reason": reason, "head": head, "at": stamp()})
        hc.say(f"proof {args.key}: waiver recorded — {reason}")
        return 0

    added = [k for k in keys if k not in required]
    hc.say(f"fix proof: keys {','.join(required) or 'none'} from the digest's high_ids"
           + (f" + {','.join(added)} added" if added else ""))
    recs = [r for r in read_records(path) if r.get("head") == head]
    by_state: dict[str, list[str]] = {"PROVEN": [], "WAIVED": [], "MISSING": []}
    for key in keys:
        state, detail = verdict(recs, key, tree)
        by_state[state].append(key)
        hc.say(f"proof {key}: {state} — {detail}")
    where = f"tree {tree[:SHORT]} · HEAD {head[:SHORT]}"
    if by_state["MISSING"]:
        hc.say(f"fix proof: FAILED — {len(by_state['MISSING'])} of {len(keys)} key(s) without a proof: "
               f"{', '.join(by_state['MISSING'])}; the close stops (ADR 0169)")
        return 1
    if by_state["WAIVED"]:
        # Never green on a waiver: the session that wrote the reason cannot also accept it.
        hc.say(f"fix proof: OWNER — {len(by_state['PROVEN'])} proven; waived {', '.join(by_state['WAIVED'])} "
               f"need the owner's acceptance in /ywr-harness:slice-close before the close goes on · {where} (ADR 0169)")
        return 3
    hc.say(f"fix proof: OK — {len(by_state['PROVEN'])} proven · {where}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
