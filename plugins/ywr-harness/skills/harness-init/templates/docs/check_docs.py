#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs-as-code drift check (ywr-harness ADR 0074).

The ready-made ADR 0068 Artifact `check` for this repo's generated docs surfaces
(index.json, INDEX.md, docs.html, docs.artifact.html, and the ADR 0060 customer
surfaces when declared) — declare it as
`check: {runner: python, script: docs/check_docs.py}` with no consumer-side
mirror of the builder. Default mode IS the drift check: exit 0 on a match,
exit 1 on drift, writes nothing. Any argument is misuse and exits 2 — there is
deliberately no `--write` here; regeneration is `pwsh docs/build.ps1` (or
`bash docs/build.sh`).

TOOLCHAIN placement (ywr-harness ADR 0010): scaffold-owned, re-placed verbatim
by `/ywr-harness:harness-init` on every run — edit the template upstream,
never this copy.
"""
import os
import subprocess
import sys

if __name__ == "__main__":
    if sys.argv[1:]:
        print("usage: python docs/check_docs.py  (no arguments — the check is the only mode)")
        sys.exit(2)
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    sys.exit(subprocess.call(
        [sys.executable, os.path.join(here, "build_docs.py"), "--check"], env=env))
