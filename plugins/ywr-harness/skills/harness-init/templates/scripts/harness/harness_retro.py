"""Slice retro gate — a zero-token deterministic retrospective, run from `post-commit`.

Ported from `ywr-platform` ADR 0072, which established the seven checks and their rationale over
several slices. This is the portable version: everything that repo hardcoded now comes from
`.harness.json`.

## Why Python and not the original POSIX sh

The original's virtue was "no dependencies" — but its scope was a literal in the script
(`^apps/(api/app/.*\\.py|web/app/.*\\.(ts|tsx)|web/lib/[^/]*\\.ts)$`). A portable gate has to read
its scope from the declaration, sh cannot parse JSON, and this harness already requires Python for
`harness_gates.py` and `verify_map.py`, so Python costs nothing new. It also drops the
Git-Bash-on-Windows dependency the sh version carried, which cost this project three separate
false-green selftests in the hooks slice.

## Contract

ADVISORY. Always exits 0, prints nothing when clean, and never blocks a commit — post-commit rather
than pre-commit precisely so a finding prompts a follow-up docs commit instead of standing between
the author and their own history.

  python harness_retro.py                  # the commit just made (HEAD); a merge commit
                                           # resolves as HEAD^1..HEAD (first-parent, ADR 0043)
  python harness_retro.py main~3..HEAD     # a whole slice — absorbs mid-slice false positives
  python harness_retro.py --coverage       # full unowned / dead-mapping audit
  SLICE_RETRO=0 git commit ...             # skip once

A check whose declaration is empty is DISABLED, and the disablement is reported under --coverage.
Per-commit silence therefore means "no finding among the ENABLED checks" — it cannot distinguish
a clean commit from a disabled check, and it does not try: repeating a deliberate disablement
(this canon declares no dependency manifest, truthfully) on every commit is the noise that gets a
hook turned off. The distinction lives where the audit runs: `--coverage` names every disabled
check, and the slice close runs it (the spec-debt ledger), so an unconfigured repo is visible
once per slice rather than never.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import harness_config as hc

hc.pin_utf8()

SPEC_RX = re.compile(r"^docs/spec/[0-9].*\.md$")
ADR_RX = re.compile(r"^docs/adr/[0-9].*\.md$")
DOCS_RX = re.compile(r"^docs/(adr|spec)/[0-9].*\.md$")


def git(root: Path, *args: str) -> str:
    # Same constraints as harness_config.git_lines (issue #40): quotepath off so a non-ASCII
    # path arrives matchable rather than octal-escaped; encoding pinned through subprocess's own
    # args because text=True would use the console codepage on Windows — this helper also reads
    # file CONTENT (`git show rev:path`), which for this org's docs is UTF-8 Korean; and
    # errors="backslashreplace" so undecodable bytes stay visible AND distinct (git_lines'
    # comment carries the full rationale).
    try:
        return subprocess.run(
            ["git", "-c", "core.quotepath=false", *args],
            cwd=root, capture_output=True, check=False,
            encoding="utf-8", errors="backslashreplace",
        ).stdout
    except OSError:
        return ""


# The docs builder's frontmatter list grammar (docs/build_docs.py parse_frontmatter, spec 0001 §3),
# mirrored for the one key this gate reads. A SECOND parser by necessity — the retro runs on the
# committed sources, not on an index that may not be rebuilt yet — so it is held to the builder by
# a pairing case (harness_retro.selftest.ps1 G4) instead of by hope: until 0.54.0 the two disagreed
# on the same field (dist issue #6 — the builder read block lists as null, this one truncated an
# item containing ']', and neither read a multi-line flow list the same way).
_FM_KEY_RE = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(.*)$")
_FM_ITEM_RE = re.compile(r"^[ \t]*-(?:[ \t]+(.*))?$")


def _cut_comment(v: str) -> str:
    """The builder's inline-comment rule: only a '#' AFTER whitespace starts a comment — or a '#'
    that starts the text, since every caller passes a stripped value or a line and `key:   # x`
    lost its whitespace to `_FM_KEY_RE`. A greedy `[...]` match would instead reach into the
    comment — the shipped spec template's `implements_in: [ ]   # ... (예: ["docs/build_docs.py"])`
    would then map a file to the template, and `[0-9]*.md` below does scan 0000-template.md."""
    m = re.search(r"(?:^|\s)#", v)
    return (v[:m.start()] if m else v).strip()


def _flow_depth(text: str) -> int:
    """The builder's flow-list bracket balance (`_flow_depth`, kept character for character): '['
    +1, ']' -1, not counted inside a quoted item (a quote at an item's head up to the same quote —
    what the item rule reads as quoted); a mid-item quote (`it's.md`) is not a quote. An unquoted
    `app/[slug]` item is balanced, so it neither opens nor closes a list."""
    depth, quote, at_item = 0, None, True
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            continue
        if at_item and ch in "\"'":
            quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        at_item = ch in "[," or (at_item and ch.isspace())
    return depth


def _item(text: str) -> str | int | None:
    """The builder's item rule (`_parse_item`): blank → None (skipped); quotes stripped; an
    UNQUOTED pure integer becomes an int, as the builder indexes it — verify_map then skips it as a
    non-path, and `spec_map` drops it the same way, so the two consumers agree on who owns what."""
    text = text.strip()
    if text == "":
        return None
    quoted = text[:1] in ('"', "'")
    text = text.strip('"').strip("'")
    return int(text) if (not quoted and re.fullmatch(r"-?\d+", text)) else text


def _flow_items(v: str) -> list[str | int]:
    # `[a, b]` → items, split on ',' exactly as the builder splits; an item may contain ']'
    # (Next.js `app/api/auth/[...nextauth]/route.ts`), which a lazy `\[(.*?)\]` truncated.
    items = (_item(p) for p in v[1:-1].split(","))
    return [p for p in items if p is not None]


def implements_in(block: list[str]) -> list[str | int]:
    """`implements_in` of one frontmatter block (its lines, fences excluded), typed exactly as the
    builder indexes it: a one-line flow `[a, b]`, a block list (`key:` then `- item` lines, blank
    and comment lines allowed between), or a multi-line flow (a `[` its own line leaves unbalanced,
    closed on the first later line that balances it and ends in `]`). A later duplicate key wins,
    as in the builder; a value of any other shape owns nothing (the builder indexes it as a
    non-list)."""
    found: list[str | int] = []
    for i, line in enumerate(block):
        m = _FM_KEY_RE.match(line)
        if not m or m.group(1) != "implements_in":
            continue
        head = _cut_comment(m.group(2).strip())
        found = []
        if head == "":
            for s in block[i + 1:]:
                if not s.strip() or s.lstrip().startswith("#"):
                    continue
                im = _FM_ITEM_RE.match(s)
                if not im:
                    break
                text = (im.group(1) or "").strip()
                q = text[:1]
                if q in ('"', "'") and text.find(q, 1) != -1:
                    text = text[:text.find(q, 1) + 1]
                else:
                    text = _cut_comment(text)
                item = _item(text)
                if item is not None:
                    found.append(item)
        elif head.startswith("["):
            flow = head
            if _flow_depth(head) > 0:
                parts = [head]
                for s in block[i + 1:]:
                    if _FM_KEY_RE.match(s):
                        break  # never closed — the builder falls back to the key line's own reading
                    seg = _cut_comment(s)
                    if seg:
                        parts.append(seg)
                        joined = " ".join(parts)
                        if _flow_depth(joined) <= 0:
                            if joined.endswith("]"):
                                flow = joined
                            break
            if flow.endswith("]"):
                found = _flow_items(flow)
    return found


def spec_map(root: Path) -> list[tuple[str, str]]:
    """(spec_path, implemented_file) pairs from every living spec's `implements_in` frontmatter.

    Every list shape the builder indexes is accepted (see `implements_in`), because a spec written
    in any of them is a valid spec, and a parser that silently understood fewer would drop part of
    the mapping while reporting full coverage. A non-string item (an unquoted number) owns nothing,
    as verify_map reads the builder's index.
    """
    out: list[tuple[str, str]] = []
    specs = sorted((root / "docs" / "spec").glob("[0-9]*.md")) if (root / "docs" / "spec").is_dir() else []
    for sp in specs:
        rel = hc.norm(str(sp.relative_to(root)))
        try:
            lines = sp.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        fm, block = 0, []
        for line in lines:
            if re.match(r"^---[ \t\r]*$", line):
                fm += 1
                if fm == 2:
                    break
                continue
            if fm == 1:
                block.append(line)
        for p in implements_in(block):
            if isinstance(p, str) and p:
                out.append((rel, hc.norm(p)))
    return out


def load_ignore(root: Path, rel: str, warns: list[str]) -> list[re.Pattern]:
    """Compiled patterns from the ignore register. Comments and blanks are skipped; the file
    doubles as the visible spec-debt list, so its comments carry meaning for the reader."""
    pats: list[re.Pattern] = []
    p = root / rel
    if not p.is_file():
        return pats
    try:
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            rx = hc.compile_re(f"^(?:{s})$", f"{rel}:{i}", warns)
            if rx:
                pats.append(rx)
    except OSError as e:
        warns.append(f"{rel}: unreadable ({type(e).__name__}) — no file is exempt from UNMAPPED")
    return pats


def any_match(pats: list[re.Pattern], path: str) -> bool:
    return any(p.search(path) for p in pats)


def unowned(files: list[str], scope: list[re.Pattern], owned: set[str], ign: list[re.Pattern]) -> list[str]:
    return [f for f in files if any_match(scope, f) and f not in owned and not any_match(ign, f)]


def frontmatter_at(root: Path, rev: str, path: str) -> str:
    """The frontmatter block of <path> at <rev>, mirroring build_docs.py: the file must OPEN with
    `---` and the block ends at the next `---`.

    Keyed to frontmatter and NOT to file content, which is the single subtlest thing in this gate.
    Both committed outputs are frontmatter-derived — the builder drops `_`-prefixed keys before
    writing index.json, and docs.html (the one output embedding the body) is gitignored — so a
    body-only edit provably produces no delta to regenerate. An append-only ADR addendum is exactly
    that shape and is the normal way to correct a committed record, so keying on "source changed"
    cried wolf on a recurring class whose only answer was to rebuild and confirm no delta by hand.
    """
    blob = git(root, "show", f"{rev}:{path}")
    if not blob:
        return ""  # absent at that rev — the caller treats it as a difference
    lines = blob.splitlines()
    if not lines or not re.match(r"^---[ \t\r]*$", lines[0]):
        return "<no-frontmatter>"  # builder skips it entirely; a constant, never the body
    body: list[str] = []
    for line in lines[1:]:
        if line.startswith("---"):
            break
        body.append(line)
    return "\n".join(body)


def resolve_range(root: Path, rev_range: str | None) -> tuple[list[tuple[str, list[str]]], list[str], str, str]:
    """(changes, subjects, pre, post). `changes` is [(status, [paths])] — rename lines carry two.

    A merge commit is a RANGE in disguise (ADR 0043): `diff-tree` without `-m` prints NOTHING
    for one, so the pre-0043 shape ran all seven checks over an empty change set — a merge
    concluded with `git commit` fired post-commit and passed silently having checked nothing.
    First-parent semantics (`HEAD^1..HEAD`): everything this merge landed on the line of
    history, subjects included. Root and ordinary commits keep the diff-tree path unchanged.

    The scope is DELIBERATELY relative to the first parent — "what arrived on the line the
    committer stood on". An octopus merge is fully covered by that range (the tree diff and the
    subject log both include every non-first leg — selftest case L3 measures it). A foxtrot
    merge (first parent = the topic side) therefore reports the OTHER line's changes; that is
    the stated semantics of an advisory gate, named rather than special-cased (review
    2026-08-10, low): parent order is what the committer's own `git merge` produced.
    """
    if not rev_range and git(root, "rev-parse", "-q", "--verify", "HEAD^2").strip():
        rev_range = "HEAD^1..HEAD"
    if rev_range:
        raw = git(root, "diff", "--name-status", "-M", rev_range)
        subjects = [s for s in git(root, "log", "--format=%s", rev_range).splitlines() if s.strip()]
        if "..." in rev_range:
            a, b = rev_range.split("...", 1)
            pre = git(root, "merge-base", a, b).strip()
            post = b or "HEAD"
        elif ".." in rev_range:
            a, b = rev_range.split("..", 1)
            pre, post = a.strip(), (b.strip() or "HEAD")
        else:
            pre, post = "", rev_range
    else:
        raw = git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--root", "HEAD")
        subjects = [s for s in git(root, "log", "-1", "--format=%s", "HEAD").splitlines() if s.strip()]
        pre = git(root, "rev-parse", "-q", "--verify", "HEAD^").strip()  # empty at a root commit
        post = "HEAD"
    changes: list[tuple[str, list[str]]] = []
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0]:
            changes.append((parts[0], [hc.norm(p) for p in parts[1:] if p]))
    return changes, subjects, pre, post


def build_findings(root: Path, cfg: dict, warns: list[str], rev_range: str | None) -> list[str]:
    changes, subjects, pre, post = resolve_range(root, rev_range)
    if not changes:
        return []

    files = [c[1][-1] for c in changes]                       # last field = current path
    # A rename can TRIGGER a check but never SATISFY one. `added` (triggers: MIGRATION, UNMAPPED)
    # keeps renames — a file moved into a scope is new to it, the conservative reading for an
    # advisory gate. The suppressors take the strict sets: a renamed ADR is not a new decision,
    # and a spec moved without an edit — or deleted — updated nothing. Until 0.55.0 both sides
    # used the loose sets, so renaming an old ADR silenced DEP and deleting a spec silenced
    # MIGRATION (ADR 0081 measurement arm, B low; review 2026-09-26). BUILD below already applied
    # the same "never suppress on what was not checked" rule. Only A counts as new: git reports
    # C only under -C, which neither diff here passes.
    added = [c[1][-1] for c in changes if c[0][:1] in ("A", "R")]
    new_files = [c[1][-1] for c in changes if c[0][:1] == "A"]
    edited = [c[1][-1] for c in changes if c[0][:1] != "D" and c[0] != "R100"]
    fileset = set(files)
    pairs = spec_map(root)
    owned = {p for _, p in pairs}
    scope = [rx for rx in (hc.compile_re(p, "retro.source_scope", warns) for p in cfg["retro"]["source_scope"]) if rx]
    deps = [rx for rx in (hc.compile_re(p, "retro.dep_manifests", warns) for p in cfg["retro"]["dep_manifests"]) if rx]
    migs = [rx for rx in (hc.compile_re(p, "retro.migrations", warns) for p in cfg["retro"]["migrations"]) if rx]
    ign = load_ignore(root, cfg["retro_ignore_file"], warns)

    f: list[str] = []

    # 1) DEP — a dependency manifest moved with no new ADR in scope. Lockfile-only changes are a
    #    version bump, not a decision, and are deliberately not matched by the declaration.
    if deps and any(any_match(deps, x) for x in files):
        if not any(ADR_RX.match(x) for x in new_files):
            f.append("DEP: dependency manifest changed, no new ADR in scope — a new dependency or "
                     "pattern needs an ADR first")

    # 2) MIGRATION — a schema migration added with no living spec touched.
    if migs and any(any_match(migs, x) for x in added):
        if not any(SPEC_RX.match(x) for x in edited):
            f.append("MIGRATION: migration added, no spec updated — check which living spec covers "
                     "the schema")

    # 3) SPEC — a changed file is some spec's implements_in, but that spec was not updated.
    for sp in sorted({s for s, p in pairs if p in fileset and s not in fileset}):
        f.append(f"SPEC: changed files are implements_in of {sp} — spec not updated in scope; "
                 "verify it still matches")

    # 4) BUILD — doc FRONTMATTER changed but the index was not regenerated. Matched on ANY path
    #    field, not just the last: a rename OUT of docs/ drops an entry from the index, and keying
    #    on the final path alone would miss it.
    doc_changes = [(st, ps) for st, ps in changes if any(DOCS_RX.match(p) for p in ps)]
    if doc_changes:
        need = False
        if not pre or not git(root, "rev-parse", "-q", "--verify", f"{pre}^{{commit}}").strip():
            need = True  # no comparable endpoint — do not suppress what cannot be checked
        else:
            for st, ps in doc_changes:
                old = ps[0]
                new = ps[-1]
                if st.startswith("M"):
                    if frontmatter_at(root, pre, old) != frontmatter_at(root, post, new):
                        need = True
                else:
                    need = True  # add/delete/rename/copy changes the entry set or its path field
        index_rel = hc.norm(cfg["index"])
        if need and index_rel not in fileset:
            f.append(f"BUILD: docs frontmatter changed but {index_rel} untouched — run: "
                     "pwsh docs/build.ps1")

    # 5) FEAT — a feat commit with no docs change at all. Coarse on purpose: the backstop for
    #    everything the structural checks cannot see.
    if any(s.startswith("feat") for s in subjects):
        if not any(x.startswith("docs/") for x in files):
            f.append("FEAT: feat commit(s) with no docs change — did this slice make a decision "
                     "(ADR) or change behavior a spec describes?")

    # 6) UNMAPPED — a NEWLY ADDED in-scope file no spec owns. Added-files-only is the same adoption
    #    strategy as staged-only lint: new code is owned from day one and the legacy baseline does
    #    not spam every commit.
    for x in unowned(added, scope, owned, ign):
        f.append(f"UNMAPPED: new file {x} is owned by no spec — add it to a spec's implements_in, "
                 f"write the missing spec, or add it to {cfg['retro_ignore_file']}")

    # 7) DEADMAP — an implements_in entry pointing at a file that no longer exists.
    for sp, p in sorted({(s, p) for s, p in pairs if not (root / p).exists()}):
        f.append(f"DEADMAP: {sp} maps {p} which does not exist — renamed or deleted; fix implements_in")

    return f


def coverage(root: Path, cfg: dict, warns: list[str]) -> int:
    print("[slice-retro] coverage report")
    pairs = spec_map(root)
    owned = {p for _, p in pairs}
    scope = [rx for rx in (hc.compile_re(p, "retro.source_scope", warns) for p in cfg["retro"]["source_scope"]) if rx]
    ign = load_ignore(root, cfg["retro_ignore_file"], warns)

    # A disabled check is REPORTED. An unconfigured repo must not read as a clean one.
    for name, decl in (("source_scope", cfg["retro"]["source_scope"]),
                       ("dep_manifests", cfg["retro"]["dep_manifests"]),
                       ("migrations", cfg["retro"]["migrations"])):
        if not decl:
            print(f"-- retro.{name} not declared — the checks it drives are DISABLED, not passing")

    dead = sorted({(s, p) for s, p in pairs if not (root / p).exists()})
    if dead:
        print(f"-- dead mappings (implements_in -> missing file): {len(dead)}")
        for s, p in dead:
            print(f"   {s}\t{p}")
    else:
        print("-- dead mappings: none")

    if scope:
        tracked = [hc.norm(x) for x in git(root, "ls-files").splitlines() if x.strip()]
        un = unowned(tracked, scope, owned, ign)
        in_scope = [x for x in tracked if any_match(scope, x)]
        if un:
            print(f"-- unowned files (in scope, no spec, not ignored): {len(un)} of {len(in_scope)} in scope")
            for x in un:
                print(f"   {x}")
        else:
            print(f"-- unowned files: none ({len(in_scope)} in scope, all owned or ignored)")
    print(f"-- ignore register: {cfg['retro_ignore_file']}"
          + ("" if (root / cfg["retro_ignore_file"]).is_file() else "   (absent — nothing is exempt)"))
    for w in warns:
        hc.warn(w)
    return 0


def main() -> int:
    # The skip hatch is read before anything else so it costs nothing when set.
    if os.environ.get("SLICE_RETRO") == "0":
        return 0

    ap = argparse.ArgumentParser(description="Deterministic slice retrospective (advisory).")
    ap.add_argument("--repo", dest="repo", default=None)
    ap.add_argument("--coverage", action="store_true")
    ap.add_argument("range", nargs="?", default=None)
    args = ap.parse_args()

    root = Path(args.repo).resolve() if args.repo else hc.find_repo_root(Path.cwd())
    cfg, warns = hc.load(root)

    if args.coverage:
        return coverage(root, cfg, warns)

    findings = build_findings(root, cfg, warns, args.range)
    if findings:
        print("[slice-retro] retro gate (zero-token advisory) — findings:")
        for x in findings:
            print(f"[slice-retro] {x}")
        print("[slice-retro] action: supplement ADR/spec as needed, rebuild the index, and commit "
              "the docs; ignore only if intentional.")
    # Warnings go to stderr even on a clean run: a malformed declaration silently narrowing the
    # checks would look identical to a repo that has nothing to report.
    for w in warns:
        hc.warn(w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
