#!/usr/bin/env bash
# docs-as-code 빌드 — adr/·spec/ 의 .md(frontmatter 포함)에서 세 산출물을 재생성.
#   index.json (기계) · INDEX.md (목차) · docs.html (브라우징)
# 산출물은 직접 편집 금지 — .md frontmatter/본문만 고친 뒤 재실행한다.
#
# 사용: bash docs/build.sh   (mac/Linux/WSL · GitHub Actions 러너)
#
# Copyright (c) 2026 YWR Labs Inc. All rights reserved.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

py=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1; then py="$cand"; break; fi
done
[ -n "$py" ] || { echo "Python을 찾을 수 없습니다 (python3/python/py)." >&2; exit 1; }

today="$(date -u +%F)"
# Encoding pin — parity with build.ps1. Harmless where the locale is already UTF-8, and the one
# thing that keeps a non-UTF-8 locale from turning the builder's own output into exit 1 after
# index.json has been written.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
exec "$py" "$here/build_docs.py" "$today"
