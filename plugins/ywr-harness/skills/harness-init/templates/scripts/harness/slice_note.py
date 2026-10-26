"""In-slice decision notes (ADR 0172). The session appends; a compaction and /slice-close read.

A slice's reasons used to reach paper only at the close: stage 5 writes the handoff and the commit
body, and ADR 0105 keeps the handoff out of the session's hands before that. A compaction between a
decision and the close could drop the reason with the summary. This script keeps one line per
decision, as the session wrote it, where neither the summary nor the work tree can touch it.

Usage:
  python slice_note.py add <decision|rejected|owner|fact|risk> <text...>
  python slice_note.py show [--range <a>..<b> | --all] [--max N]
  python slice_note.py --repo <dir> ...

The journal lives under `git rev-parse --git-path` (per worktree, never tracked), so a note never moves
the `--tree` snapshot a ready report ends with. Each record carries the HEAD it was written at, and
`show` selects by HEAD. The slice starts at its base: the last commit that touched the handoff that
`.harness.json` declares, because every close commits the handoff. `show` takes the notes at the base
and at every commit after it, so a commit inside the slice keeps the earlier notes, and the next close
retires them with no delete step. Each note also records the base it was written under, and `show` keeps a
note whose base is the current one: an amend or a rebase of the slice's own commits keeps the base, so
their notes stay (ADR 0172 lists the cases that move it). Without a declared or committed handoff the
base is HEAD itself. The
journal is append-only.

A note is the session's own claim. The SessionStart `compact` hook re-injects `show`'s output marked
as such, and /slice-close checks each note against the tree before it keeps one: input, never proof
(ADR 0105).
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import harness_config as hc

hc.pin_utf8()

JOURNAL = "ywr-harness/slice-notes.jsonl"
KINDS = ("decision", "rejected", "owner", "fact", "risk")
# Counted in UTF-16 code units, not code points: the host caps each hook string at 10,000 characters,
# and an astral character (an emoji, CJK Extension B) is two units in a JavaScript string. The compact
# hook's note count is sized from this bound, so a code-point count would let 17 notes overflow it.
MAX_TEXT = 500
# Control, format, line/paragraph separator and lone surrogates: each can break the one-line shape
# or hide text from the reader (a bidi override, U+2028). Hangul and every other letter pass.
REFUSED_CATEGORIES = {"Cc", "Cf", "Zl", "Zp", "Cs"}
UNBORN = "none"
# The shapes `add` writes. `show` holds a hand-written line to them too, so no field of a valid record can
# grow a `show` line past the bound the compact hook is sized from.
TS_RX = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
HEAD_RX = re.compile(r"none|[0-9a-f]{40}|[0-9a-f]{64}")
BASE_RX = re.compile(r"|[0-9a-f]{40}|[0-9a-f]{64}")
SHORT = 12
TAIL = "input, never proof (ADR 0172)"


def journal_path(root: Path) -> Path:
    return root / hc.git_run(root, "rev-parse", "--git-path", JOURNAL).strip()


def head_of(root: Path) -> str:
    """HEAD's commit id, or `none` on an unborn branch. Any other git failure raises."""
    try:
        return hc.git_run(root, "rev-parse", "-q", "--verify", "HEAD^{commit}").strip()
    except subprocess.CalledProcessError as e:
        if e.returncode != 1:
            raise
    # `-q --verify` exits 1 both on an unborn branch and outside a repository; only the first is a HEAD.
    hc.git_run(root, "rev-parse", "--git-dir")
    return UNBORN


def units(text: str) -> int:
    """The UTF-16 length, as a JavaScript string counts it."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def text_problem(text: str) -> str:
    """'' when the text is a valid note body, else why not."""
    if not text:
        return "the text is empty"
    if units(text) > MAX_TEXT:
        return f"the text has {units(text)} UTF-16 units, more than {MAX_TEXT}"
    for ch in text:
        if unicodedata.category(ch) in REFUSED_CATEGORIES:
            return f"the text holds U+{ord(ch):04X}, a control, format or line separator character"
    return ""


def valid(rec) -> bool:
    return (isinstance(rec, dict) and all(isinstance(rec.get(k), str) for k in ("ts", "head", "kind", "text"))
            and bool(TS_RX.fullmatch(rec["ts"])) and bool(HEAD_RX.fullmatch(rec["head"]))
            and isinstance(rec.get("base", ""), str) and bool(BASE_RX.fullmatch(rec.get("base", "")))
            and rec["kind"] in KINDS and not text_problem(rec["text"]))


def read_notes(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out = []
    # `replace`: torn bytes become a line that fails the checks below and is named, never a traceback.
    for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            rec = None
        if not valid(rec):
            hc.warn(f"{path.name}:{n} is not a slice note — ignored")
            continue
        out.append(rec)
    return out


def append(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(rec, ensure_ascii=True) + "\n")


def stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slice_base(root: Path, head: str, notices: list[str]) -> str:
    """The last commit on HEAD's history that touched the declared handoff, or '' (no handoff, unborn).
    A refused handoff value narrows the slice to HEAD; its warning goes to `notices` for the caller."""
    if head == UNBORN:
        return ""
    cfg, warns = hc.load(root)
    notices.extend(f"{w} — the slice is then HEAD only" for w in warns if w.startswith("handoff"))
    handoff = cfg.get("handoff") or ""
    if not handoff:
        return ""
    # `:(literal)`: a declared value is a path, never pathspec magic such as `:(glob)` or `:(exclude)`.
    return hc.git_run(root, "log", "-1", "--format=%H", "HEAD", "--", ":(literal)" + handoff).strip()


def range_heads(root: Path, rng: str) -> set[str]:
    """`<a>` itself plus every commit `git rev-list <a>..<b>` lists. Raises ValueError on a bad shape."""
    parts = rng.split("..")
    if len(parts) != 2 or not parts[0] or not parts[1] or parts[1].startswith("."):
        raise ValueError(f"not a <a>..<b> range: {hc.one_line(rng)}")
    base = hc.git_run(root, "rev-parse", "--verify", "--end-of-options", parts[0] + "^{commit}").strip()
    return {base, *hc.git_lines(root, "rev-list", "--end-of-options", rng)}


def line_for(i: int, rec: dict, with_head: bool) -> str:
    where = f" {rec['head'][:SHORT]}" if with_head else ""
    return f"  {i}. {rec['ts']}{where} {rec['kind']}: {rec['text']}"


def main() -> int:
    try:
        return note_main()
    except OSError as e:
        hc.say(f"slice notes: FAILED — journal I/O: {e} (ADR 0172)")
        return 2


def note_main() -> int:
    ap = argparse.ArgumentParser(description="Append and show the session's in-slice decision notes (ADR 0172).")
    ap.add_argument("--repo", dest="repo", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add", help="append one note at the current HEAD")
    p_add.add_argument("kind", choices=KINDS)
    p_add.add_argument("text", nargs="+")
    p_show = sub.add_parser("show", help="print the notes at the current HEAD (input, never proof)")
    sel = p_show.add_mutually_exclusive_group()
    sel.add_argument("--range", dest="rng", default=None, help="also the notes at <a> and at each commit of <a>..<b>")
    sel.add_argument("--all", action="store_true", help="every note, with its HEAD")
    p_show.add_argument("--max", type=int, default=None, help="only the newest N notes of the selection")
    args = ap.parse_args()

    if args.cmd == "add":
        text = " ".join(args.text).strip()
        problem = text_problem(text)
        if problem:
            hc.say(f"slice note: REFUSED — {problem}; nothing was written (ADR 0172)")
            return 2
    elif args.max is not None and args.max < 1:
        hc.say("slice notes: FAILED — --max needs a number of 1 or more")
        return 2

    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    try:
        path = journal_path(root)
        head = head_of(root)
        heads = {head}
        notices: list[str] = []
        base = slice_base(root, head, notices)
        if args.cmd == "show":
            if base and base != head:
                heads |= range_heads(root, f"{base}..{head}")
            if args.rng is not None:
                heads |= range_heads(root, args.rng)
    except ValueError as e:
        hc.say(f"slice notes: FAILED — {e}")
        return 2
    except subprocess.CalledProcessError as e:
        print(f"git failed: {(e.stderr or '').strip()}", file=sys.stderr)
        hc.say("slice notes: FAILED — git could not resolve the repository, HEAD or the range (ADR 0172)")
        return 2

    notes = read_notes(path)
    if args.cmd == "add":
        for n in notices:
            hc.warn(n)
        append(path, {"ts": stamp(), "head": head, "base": base, "kind": args.kind, "text": text})
        n = 1 + sum(1 for r in notes if r["head"] == head)
        hc.say(f"slice note {n} recorded ({args.kind}) at HEAD {head[:SHORT]}")
        return 0

    # A note stays in the slice by its commit, or by the base it was written under (an amend or a rebase
    # rewrites the commit, never the base).
    picked = notes if args.all else [r for r in notes if r["head"] in heads or (base and r.get("base") == base)]
    others = len(notes) - len(picked)
    if args.all:
        what = "in the journal"
    else:
        what = f"at HEAD {head[:SHORT]}"
        if base and base != head:
            what += f" since the handoff commit {base[:SHORT]}"
        if args.rng is not None:
            what += f" and the range {hc.one_line(args.rng)}"
    # A narrowed selection is said on stdout and FIRST: the compact hook reads stdout only, and it stays
    # silent on a first line of `slice notes: none`.
    for n in notices:
        hc.say(f"slice notes: warning — {n}")
    hc.say(f"slice notes: {len(picked) or 'none'} {what} · {TAIL}")
    dropped = 0
    if args.max is not None and len(picked) > args.max:
        dropped = len(picked) - args.max
    for i, rec in enumerate(picked[dropped:], dropped + 1):
        hc.say(line_for(i, rec, args.all))
    if dropped:
        hc.say(f"slice notes: {dropped} older not shown (--max {args.max})")
    if others:
        hc.say(f"slice notes: {others} more at other HEADs (show --all)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
