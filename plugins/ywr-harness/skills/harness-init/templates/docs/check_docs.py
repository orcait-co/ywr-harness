#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs-as-code drift check (ywr-harness ADR 0074).

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

TOOLCHAIN placement (ywr-harness ADR 0010): scaffold-owned, re-placed verbatim
by `/ywr-harness:harness-init` on every run — edit the template upstream,
never this copy.
"""
import os
import subprocess
import sys

if __name__ == "__main__":
    if any(a.startswith("-") for a in sys.argv[1:]):
        print("usage: python docs/check_docs.py [changed paths...]  (no flags — the check is the "
              "only mode; paths trigger it and do not narrow it)")
        sys.exit(2)
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    sys.exit(subprocess.call(
        [sys.executable, os.path.join(here, "build_docs.py"), "--check"], env=env))
