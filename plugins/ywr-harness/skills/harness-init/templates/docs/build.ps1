<#
.SYNOPSIS
  docs-as-code 빌드 — adr/·spec/ 의 .md(frontmatter 포함)에서 세 산출물을 재생성.

.DESCRIPTION
  진실원은 docs/adr, docs/spec 의 개별 .md 다. 본 스크립트는 build_docs.py 를 호출해:
    - index.json : 에이전트/기계용 구조화 메타 + 의존 그래프
    - INDEX.md   : 사람/에이전트용 경량 목차
    - docs.html  : 사람용 단일 브라우징 HTML
  를 생성한다. 산출물은 직접 편집하지 말 것 — .md frontmatter/본문만 고친 뒤 재실행.

.EXAMPLE
  pwsh ./docs/build.ps1

.NOTES
  Copyright (c) 2026 YWR Labs Inc. All rights reserved.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$py = $null
foreach ($cand in 'python', 'python3', 'py') {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
}
if (-not $py) { throw "Python을 찾을 수 없습니다. python / python3 / py 중 하나가 PATH에 있어야 합니다." }

# Encoding pin. The builder prints non-ASCII, and Python on Windows encodes stdout with the
# console codepage: on a cp1252 console `print()` raises UnicodeEncodeError and the process exits
# 1 AFTER index.json has already been written — a half-built corpus reported as a build failure.
# Measured on GitHub's windows-latest runner 2026-07-26 and reproduced locally by forcing
# PYTHONIOENCODING=cp1252. This is the Python-side twin of the child-output decoding pin.
$prevUtf8 = $env:PYTHONUTF8
$prevIo = $env:PYTHONIOENCODING
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
try { & $py (Join-Path $root 'build_docs.py') }
finally {
    if ($null -eq $prevUtf8) { Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue } else { $env:PYTHONUTF8 = $prevUtf8 }
    if ($null -eq $prevIo) { Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue } else { $env:PYTHONIOENCODING = $prevIo }
}
