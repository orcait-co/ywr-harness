// docs-as-code 빌드 — adr/·spec/ 의 .md(frontmatter 포함)에서 네 산출물을 재생성.
//
// 진실원은 docs/adr, docs/spec 의 개별 .md 다. 이 스크립트는 같은 폴더의 build_docs.py 를 호출해
//   index.json         : 에이전트/기계용 구조화 메타 + 의존 그래프
//   INDEX.md           : 사람/에이전트용 경량 목차
//   docs.html          : 사람용 단일 브라우징 HTML
//   docs.artifact.html : claude.ai Artifact 발행용 fragment
// 를 생성한다. 산출물은 직접 편집하지 말 것 — .md frontmatter/본문만 고친 뒤 재실행.
//
// 사용: node docs/build.mjs   (Node 22 이상, 내장 모듈만 사용)
//
// Copyright (c) 2026 YWR Labs Inc. All rights reserved.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// The first of python, python3, py that is on PATH. On Windows only a program (.com, .exe) or a batch
// file (.bat, .cmd) counts, in PATHEXT order: an extensionless file (a pyenv-win sh shim) cannot start
// there, and a batch file starts only through cmd.exe (see the spawn below).
const RUNNABLE = ['.COM', '.EXE', '.BAT', '.CMD']
function findOnPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const win = process.platform === 'win32'
  const exts = win
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toUpperCase()).filter(e => RUNNABLE.includes(e))
    : ['']
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e)
      try {
        fs.lstatSync(p)
        if (!win) fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch { /* not in this directory */ }
    }
  }
  return null
}

const py = ['python', 'python3', 'py'].map(findOnPath).find(Boolean)
if (!py) {
  process.stderr.write('Python을 찾을 수 없습니다. python / python3 / py 중 하나가 PATH에 있어야 합니다.\n')
  process.exitCode = 1
} else {
  // Encoding pin. The builder prints non-ASCII, and Python on Windows encodes stdout with the
  // console codepage: on a cp1252 console `print()` raises UnicodeEncodeError and the process exits
  // 1 AFTER index.json has already been written — a half-built corpus reported as a build failure.
  // Reproduce it on any Windows host by setting PYTHONIOENCODING=cp1252 before the build. The pin
  // is set on the child's environment only, so the caller's environment is never touched.
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  const script = path.join(here, 'build_docs.py')
  // Node starts a .bat/.cmd only through a shell. cmd.exe's /s drops the outer quote pair, so each path
  // keeps its own quotes inside it and a space in a path cannot split it.
  const r = /\.(bat|cmd)$/i.test(py)
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${py}" "${script}""`], { stdio: 'inherit', env, windowsVerbatimArguments: true })
    : spawnSync(py, [script], { stdio: 'inherit', env })
  // 자식 종료 코드를 명시적으로 전파한다 — 중복 id 는 결정론적 빌드 실패이고(ywr-harness ADR 0043), 래퍼가
  // 그것을 0 으로 바꾸면 사람이 실행하는 경로에서만 게이트가 사라진다. 시작 실패나 신호 종료는 1 이다.
  process.exitCode = r.error ? 1 : (r.status ?? 1)
}
