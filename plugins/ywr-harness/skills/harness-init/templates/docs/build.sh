#!/usr/bin/env bash
# Docs build: regenerates four outputs from the .md files (frontmatter included) under adr/ and spec/.
#   index.json (machine index) · INDEX.md (table of contents) · docs.html (browsing) · docs.artifact.html (publishing)
# Never edit an output by hand. Edit the .md frontmatter or body, then run this script again.
#
# Usage: bash docs/build.sh   (macOS, Linux, WSL, GitHub Actions runner)
#
# Copyright (c) 2026 YWR Labs Inc. All rights reserved.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "Node를 찾을 수 없습니다 (Node 22 이상이 PATH에 있어야 합니다)." >&2; exit 1; }

exec node "$here/build_docs.mjs"
