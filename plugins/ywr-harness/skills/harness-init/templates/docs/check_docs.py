#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs-as-code drift check (ywr-harness ADR 0074) and STE-lite gate (ADR 0128).

The ready-made ADR 0068 Artifact `check` for this repo's generated docs surfaces
(index.json, INDEX.md, docs.html, docs.artifact.html, and the ADR 0060 customer
surfaces when declared) — declare it as
`check: {runner: python, script: docs/check_docs.py}` with no consumer-side
mirror of the builder. Default mode IS the drift check: exit 0 on a match,
exit 1 on drift, writes nothing. A flag (any argument starting with `-`) is misuse
and exits 2 — there is deliberately no `--write` here; regeneration is
`pwsh docs/build.ps1` (or `bash docs/build.sh`).

Path arguments are TRIGGERS, not a scope (ADR 0094): a `.harness.json` group may
declare this script with `files: true` so the pre-commit hook runs it on a staged
ADR/spec instead of deferring it to CI. The drift check is corpus-wide either way —
the index is assembled from every source — so the paths never narrow what runs.

With path arguments the STE-lite gate runs too (ADR 0128, docs/README.md §Writing
style). It reads each passed spec and NEW ADR against HEAD (`git diff HEAD`, the
working tree the pre-commit hook gates) and checks R5 (sentence length), R3
(no claim in parentheses) and R8 (no em dash, joining semicolon, "(s)" or
"and/or") over every changed spec section, whole, plus R7 for the words that
`.harness.json` `docs.ste_words` maps to a replacement (ADR 0170). A new ADR must
also record at least two options in its options section. These ADR 0170 checks
block only under their own key, `docs.ste_marks: true`. A records
section — a heading naming change notes or a ledger, or one carrying
`<!-- ste-lite: records -->` — is not checked: nobody rewrites a ledger row.
`<!-- ste-lite: verbatim -->` on its own line exempts the next block (a paragraph,
list or table): text a script reads stays byte-identical. Findings fail the run
only when `.harness.json` declares `docs.ste_lite: true`; otherwise they print as
advice and the exit code is the drift check's. A clean tree (CI) has no change
against HEAD, so the gate finds nothing there. No arguments: drift check only, so
the ADR 0068 `check` contract is unchanged.

TOOLCHAIN placement (ywr-harness ADR 0010): scaffold-owned, re-placed verbatim
by `/ywr-harness:harness-init` on every run — edit the template upstream,
never this copy.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

LIMIT = 25        # R5: a descriptive sentence
STEP_LIMIT = 20   # R5: a procedure step, read as an ordered-list item
DOC_RX = re.compile(r"^[0-9]{4}-.+\.md$")
HEADING_RX = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
NUMBERED_RX = re.compile(r"^§?[0-9]+(\.[0-9]+)*\.?(\s|$)")
RECORDS_RX = re.compile(r"change notes|ledger|변경 이력", re.I)
FENCE_RX = re.compile(r"^\s*(`{3,}(?=[^`]*$)|~{3,})")
ITEM_RX = re.compile(r"^(\s*)([-*+]|[0-9]+[.)])\s+(.*)$")
MARK_RX = re.compile(r"^\s*<!--\s*ste-lite:\s*(records|verbatim)\s*-->\s*$")
HUNK_RX = re.compile(r"^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@")
SEP_ROW_RX = re.compile(r"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
OPTIONS_RX = re.compile(r"(?<!\w)(?:options?|alternatives?)(?!\w)|선택지|대안", re.I)
MIN_OPTIONS = 2   # a new ADR records the option it took and at least one it rejected (ADR 0170)
# R8: marks a translator reads more than one way (docs/README.md §Writing style, ADR 0170).
R8_MARKS = (("em dash", re.compile(r"\u2014|&mdash;|&#8212;|&#x2014;", re.I)),
            ("\"(s)\"", re.compile(r"\w\(e?s\)")),
            ("\"and/or\"", re.compile(r"(?<!\w)and/or(?!\w)", re.I)))
ENTITY_RX = re.compile(r"&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);", re.I)
ABBREV = {"e.g.", "i.e.", "etc.", "vs.", "cf.", "approx.", "incl.", "no.", "fig."}
# R3: words a short reference may use besides id-like tokens (docs/README.md §Writing style).
REF_WORDS = {"adr", "adrs", "spec", "specs", "fact", "facts", "issue", "issues", "slice",
             "slices", "sweep", "sweeps", "step", "steps", "invariant", "invariants", "rule",
             "rules", "option", "options", "owner", "see", "item", "items", "row", "rows",
             "case", "cases", "run", "runs", "review", "section", "sections", "dist", "canon",
             "plugin", "host", "version", "release", "handoff", "record", "manifest", "tree",
             "final", "commit", "tag", "eval", "ledger", "and", "or", "also", "in"}


def _ascii(text: str) -> str:
    return text.encode("ascii", "backslashreplace").decode("ascii")


def _plain(text: str) -> str:
    """Inline markdown → countable text: a code span is one word, a link keeps its label."""
    text = re.sub(r"(`+)(.+?)\1", " CODE ", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<https?://[^>]*>", " URL ", text)
    text = re.sub(r"https?://[^\s)>]+", " URL ", text)   # a bare URL: no R8 or R7 match inside it
    return re.sub(r"<[^>]+>", " ", text)


def _words(sentence: str) -> int:
    return sum(1 for t in sentence.split() if re.search(r"\w", t))


def _sentences(text: str) -> list[str]:
    out, start = [], 0
    for m in re.finditer(r"[.!?][)\"'*_\]]*(\s+)(?=\S)", text):
        nxt = text[m.end()]
        word = text[:m.start() + 1].split()[-1].lower().lstrip("*_(\"'")
        if "a" <= nxt <= "z" or word in ABBREV:
            continue
        out.append(text[start:m.start() + 1])
        start = m.end()
    out.append(text[start:])
    return [s.strip() for s in out if s.strip()]


def _ref_token(tok: str) -> bool:
    t = tok.strip(".,;:")
    return bool(t) and (t.lower() in REF_WORDS or t == "CODE" or bool(re.search(r"[0-9§#]", t))
                        or bool(re.fullmatch(r"[A-Z][A-Z0-9]{1,7}", t))
                        or bool(re.search(r"\w[-/._]\w", t)))


def _claims(text: str) -> list[str]:
    """R3: each outermost parenthesized group that is not a single token or a reference list."""
    found, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        if ch == "(":
            if depth == 0:
                start = i + 1
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
            if depth == 0:
                inner = text[start:i].strip()
                if len(inner.split()) > 1 and not all(
                        _ref_token(w) for part in re.split(r"[,;/·]", inner) for w in part.split()):
                    found.append(inner)
    return found


def _joining_semicolons(text: str) -> int:
    """R8: semicolons outside parentheses. A reference list such as "(ADR 1; spec 2)" may use one,
    and an HTML entity ends in one."""
    text, depth, n = ENTITY_RX.sub(" ", text), 0, 0
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
        elif ch == ";" and not depth:
            n += 1
    return n


def _marks(text: str, words: dict[str, str]) -> list[tuple[str, str]]:
    """R8 and the declared R7 words in one cell or unit of plain text: (rule, label) per kind found.
    A table cell that holds only an em dash is the empty-cell mark, not a dash in a sentence."""
    found = []
    if text.strip() != "\u2014":
        found += [("R8", label) for label, rx in R8_MARKS if rx.search(text)]
    if _joining_semicolons(text):
        found.append(("R8", "joining semicolon"))
    for word, use in words.items():
        if re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", text, re.I):
            found.append(("R7", f"\"{word}\" -> \"{use}\""))
    return found


def _option_count(heads: list[dict], units: list[dict]) -> tuple[int, int] | None:
    """A new ADR's options: (heading line, count) for its first level-2 options heading, or None
    without one. Each table body row, list item and sub-heading in that section counts once, so a
    nested list or a non-option row counts too: the count errs toward a pass (ADR 0170)."""
    head = next((h for h in heads if h["level"] == 2 and OPTIONS_RX.search(h["text"])), None)
    if head is None:
        return None
    end = next((h["line"] for h in heads if h["line"] > head["line"] and h["level"] <= 2), 10 ** 9)
    count = sum(1 for u in units if head["line"] < u["start"] < end and u["kind"] != "para")
    count += sum(1 for h in heads if head["line"] < h["line"] < end)
    return head["line"], count


def _units(lines: list[str]) -> tuple[list[dict], list[dict], list[int]]:
    """Parse a document body into headings and checkable units, each with its 1-based line span.
    A unit is a paragraph, a list item or one table body row; fences, comments and frontmatter
    hold none. A `verbatim` marker exempts the next block; a `records` marker names its section."""
    heads, units, marks = [], [], []
    i, n, block, verbatim, pending = 0, len(lines), 0, False, False
    if lines and lines[0].strip() == "---":
        i = next((k + 1 for k in range(1, n) if lines[k].strip() == "---"), n)
    cur, in_table = None, False

    def close():
        nonlocal cur
        if cur:
            units.append(cur)
        cur = None

    while i < n:
        line, ln = lines[i], i + 1
        s = line.strip()
        if FENCE_RX.match(line):
            close(); in_table = False
            tick = FENCE_RX.match(line).group(1)
            i += 1
            while i < n and not re.fullmatch(re.escape(tick[0]) + "{%d,}" % len(tick),
                                             lines[i].strip()):
                i += 1
            i += 1; block += 1; verbatim = pending = False
            continue
        mk = MARK_RX.match(line)
        if mk:
            close(); in_table = False
            if mk.group(1) == "verbatim":
                pending = True
            else:
                marks.append(ln)
            i += 1
            continue
        if s.startswith("<!--"):
            close(); in_table = False
            while i < n and "-->" not in lines[i]:
                i += 1
            i += 1
            continue
        h = HEADING_RX.match(line)
        if h:
            close(); in_table = False
            heads.append({"line": ln, "level": len(h.group(1)), "text": h.group(2),
                          "numbered": bool(NUMBERED_RX.match(h.group(2)))})
            i += 1
            continue
        if not s:
            close(); in_table = False
            i += 1
            continue
        if s.startswith("|"):
            close()
            if not in_table:
                in_table, block = True, block + 1
                verbatim, pending = pending, False
                if i + 1 < n and SEP_ROW_RX.match(lines[i + 1].strip()):
                    i += 1                   # a header row, the label row above a separator
                    continue
            if not SEP_ROW_RX.match(s):
                units.append({"start": ln, "end": ln, "kind": "row", "text": s, "skip": verbatim})
            i += 1
            continue
        in_table = False
        it = ITEM_RX.match(line)
        if it:
            close()
            if not units or units[-1]["kind"] not in ("item", "step") or units[-1]["end"] != ln - 1:
                block += 1
                verbatim, pending = pending, False
            cur = {"start": ln, "end": ln, "kind": "step" if it.group(2)[0].isdigit() else "item",
                   "text": it.group(3), "skip": verbatim}
            i += 1
            continue
        if cur:
            cur["text"] += " " + s.lstrip("> ")
            cur["end"] = ln
        else:
            block += 1
            verbatim, pending = pending, False
            cur = {"start": ln, "end": ln, "kind": "para", "text": s.lstrip("> "), "skip": verbatim}
        i += 1
    close()
    return heads, units, marks


def _section_of(heads: list[dict], ln: int) -> int:
    """The changed section that owns line `ln`, named by its heading line (0 = the preamble): the
    deepest numbered heading whose scope holds the line, up to the next numbered heading; with no
    numbered heading in scope, the nearest heading above (docs/README.md §Writing style)."""
    above = [h for h in heads if h["line"] <= ln]
    if not above:
        return 0
    stack = []                               # the numbered headings whose scope is still open
    for h in above:
        stack = [o for o in stack if o["level"] < h["level"]]
        if h["numbered"]:
            stack.append(h)
    return stack[-1]["line"] if stack else above[-1]["line"]


def _changed_lines(root: Path, rel: str, hc) -> tuple[set[int], set[int]] | None:
    """(changed, anchors) against HEAD; None when the file is new against HEAD. `changed` holds
    the working-tree lines a hunk adds or rewrites. `anchors` holds, for each pure deletion, the
    line above it, which selects that section. A deletion whose first non-blank removed line is a
    heading removed whole sections and selects nothing."""
    try:                                     # `./`: relative to `root`, not to the git top level
        hc.git_run(root, "cat-file", "-e", f"HEAD:./{rel}")
    except subprocess.CalledProcessError:
        return None
    out = hc.git_run(root, "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "-U0",
                     "HEAD", "--", rel)
    changed, anchors, pending = set(), set(), None
    for line in out.splitlines():
        m = HUNK_RX.match(line)
        if m:
            start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
            changed.update(range(start, start + count))
            pending = max(start, 1) if count == 0 else None
        elif pending is not None and line.startswith("-") and line[1:].strip():
            if not HEADING_RX.match(line[1:]):
                anchors.add(pending)
            pending = None
    return changed, anchors


def _check_file(path: Path, rel: str, diff: tuple[set[int], set[int]] | None,
                out: list[str], words: dict[str, str] | None = None,
                adr: bool = False) -> tuple[int, int, int]:
    """Check one file; append report lines to `out`. Returns (sections checked, R3 and R5
    findings, ADR 0170 findings). `words` maps each declared R7 word to its replacement; `adr`
    marks a new ADR, whose options section is counted too."""
    words = words or {}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    heads, units, marks = _units(lines)
    names = {h["line"]: h["text"] for h in heads}
    names[0] = "(preamble)"
    if diff is None:
        touched = {_section_of(heads, u["start"]) for u in units}
    else:
        fm_end = 0
        if lines and lines[0].strip() == "---":
            fm_end = next((k + 1 for k in range(1, len(lines)) if lines[k].strip() == "---"), 0)
        # A blank line selects nothing: an added section's leading blank sits above its heading.
        changed = {ln for ln in diff[0] if ln > fm_end and ln <= len(lines) and lines[ln - 1].strip()}
        touched = {_section_of(heads, ln) for ln in changed | diff[1] if ln > fm_end}
    # A records section (change notes, a ledger) is not checked at all: nobody rewrites a
    # ledger row, so a finding there is noise (owner decision 2026-10-09, ADR 0128).
    records = {sec for sec in touched if RECORDS_RX.search(names.get(sec, ""))}
    records |= {_section_of(heads, m) for m in marks}
    findings = marked = 0
    for sec in sorted(touched):
        mode = "records, not checked" if sec in records else "whole"
        out.append(f"[ste-lite]   {rel} {_ascii(names.get(sec, '?'))} ({mode})")
    for u in units:
        sec = _section_of(heads, u["start"])
        if sec not in touched or sec in records or u["skip"]:
            continue
        texts = ([c for c in re.split(r"(?<!\\)\|", u["text"].strip().strip("|"))]
                 if u["kind"] == "row" else [u["text"]])
        limit = STEP_LIMIT if u["kind"] == "step" else LIMIT
        for t in texts:
            plain = _plain(t)
            for rule, label in _marks(plain, words):
                marked += 1
                out.append(f"[ste-lite]   {rule} {rel}:{u['start']} {_ascii(label)}: "
                           f"\"{_ascii(' '.join(plain.split()[:8]))} ...\"")
            for s in _sentences(plain):
                w = _words(s)
                if w > limit:
                    findings += 1
                    head = " ".join(s.split()[:8])
                    out.append(f"[ste-lite]   R5 {rel}:{u['start']} {w} words > {limit}: "
                               f"\"{_ascii(head)} ...\"")
            for c in _claims(plain):
                findings += 1
                out.append(f"[ste-lite]   R3 {rel}:{u['start']} claim in parentheses: "
                           f"\"({_ascii(c[:60])})\"")
    if adr:
        opts = _option_count(heads, units)
        if opts is None or opts[1] < MIN_OPTIONS:
            marked += 1
            out.append(f"[ste-lite]   OPT {rel}:{opts[0] if opts else 1} "
                       + (f"{opts[1]} option, fewer than {MIN_OPTIONS}" if opts
                          else "no options section")
                       + ": record the option taken and at least one rejected option")
    return len(touched - records), findings, marked


def ste_lite(here: Path, paths: list[str]) -> int:
    """Run the STE-lite gate over the passed paths. Returns 1 when a finding must fail the run."""
    here = here.resolve()
    docs = [here / "spec", here / "adr"]
    picked = [p for p in (Path(a).resolve() for a in paths)
              if p.parent in docs and DOC_RX.match(p.name) and not p.name.startswith("0000-")
              and p.is_file()]
    if not picked:
        print("[ste-lite] OK - no spec or ADR of this docs tree among the passed paths")
        return 0
    sys.path.insert(0, str(here.parent / "scripts" / "harness"))
    try:
        import harness_config as hc
    except ImportError:                      # the mode is unreadable, so the gate cannot block
        print("[ste-lite] NOT CHECKED (scripts/harness/harness_config.py missing - re-run "
              "/ywr-harness:harness-init); the gate did not run and does not block")
        return 0
    root = hc.find_repo_root(here)
    cfg, warns = hc.load(root)
    for w in warns:
        if w.startswith(("docs.ste_lite", "docs.ste_marks", "docs.ste_words")):
            print(f"[ste-lite] WARN {_ascii(w)}")
    # Two keys (ADR 0170): R3 and R5 block under docs.ste_lite, which the scaffold seed declares.
    # R8, the R7 words and the option count block only under docs.ste_marks, which it does not.
    core_blocks, marks_block = cfg.get("ste_lite") is True, cfg.get("ste_marks") is True
    blocking = core_blocks or marks_block
    out, findings, marked, sections, files, adrs = [], 0, 0, 0, 0, 0
    for p in picked:
        arg = str(p)
        try:
            rel = p.relative_to(root).as_posix()
            changed = _changed_lines(root, rel, hc)
        except (ValueError, subprocess.CalledProcessError, OSError) as e:
            for line in out:                 # the files read so far still report
                print(line)
            print(f"[ste-lite] NOT CHECKED ({_ascii(str(arg))}: {type(e).__name__})"
                  + ("" if blocking else "; advisory mode, so the gate does not block"))
            return 1 if blocking else 0
        if p.parent == here / "adr" and changed is not None:
            continue                         # an accepted ADR is append-only: never rewritten
        adr = p.parent == here / "adr"
        n, f, m = _check_file(p, rel, changed, out, cfg.get("ste_words") or {}, adr)
        adrs += adr
        files += 1 if n or f or m else 0
        sections += n
        findings += f
        marked += m
    for line in out:
        print(line)
    if not files:
        print("[ste-lite] OK - no checked section: nothing changed outside records sections")
        return 0
    if not findings and not marked:
        print(f"[ste-lite] OK - {sections} section(s) in {files} file(s) pass R3, R5, R8"
              + (", R7 words" if cfg.get("ste_words") else "")
              + (" and the ADR option count" if adrs else ""))
        return 0
    fails = (core_blocks and findings > 0) or (marks_block and marked > 0)
    verdict = "FAIL" if fails else "ADVISORY"
    print(f"[ste-lite] {verdict} - {findings + marked} finding(s). Rewrite each listed section in "
          f"STE-lite (docs/README.md §Writing style).")
    if findings and not core_blocks:
        print("[ste-lite]   advisory: declare \"docs\": {\"ste_lite\": true} in .harness.json "
              "to make R3 and R5 block (ADR 0128).")
    if marked and not marks_block:
        print("[ste-lite]   advisory: declare \"docs\": {\"ste_marks\": true} in .harness.json "
              "to make R8, the R7 words and the ADR option count block (ADR 0170).")
    return 1 if fails else 0


if __name__ == "__main__":
    if any(a.startswith("-") for a in sys.argv[1:]):
        print("usage: python docs/check_docs.py [changed paths...]  (no flags — the check is the "
              "only mode; paths trigger it and do not narrow it)")
        sys.exit(2)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    here = Path(os.path.dirname(os.path.abspath(__file__)))
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    sys.stdout.flush()
    drift = subprocess.call(
        [sys.executable, os.path.join(here, "build_docs.py"), "--check"], env=env)
    if not sys.argv[1:]:
        sys.exit(drift)
    ste = ste_lite(here, sys.argv[1:])
    sys.exit(2 if drift == 2 else max(drift, ste))
