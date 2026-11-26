#!/usr/bin/env bash
# docs-as-code 빌드 — adr/·spec/ 의 .md(frontmatter 포함)에서 네 산출물을 재생성.
#   index.json (기계) · INDEX.md (목차) · docs.html (브라우징) · docs.artifact.html (Artifact 발행용)
# 산출물은 직접 편집 금지 — .md frontmatter/본문만 고친 뒤 재실행한다.
#
# 사용: bash docs/build.sh   (mac/Linux/WSL · GitHub Actions 러너)
#
# Copyright (c) 2026 YWR Labs Inc. All rights reserved.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "Node를 찾을 수 없습니다 (Node 22 이상이 PATH에 있어야 합니다)." >&2; exit 1; }

exec node "$here/build_docs.mjs"
