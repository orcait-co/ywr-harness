// docs-as-code 빌드 — adr/·spec/ 의 .md(frontmatter 포함)에서 네 산출물을 재생성.
//
// 진실원은 docs/adr, docs/spec 의 개별 .md 다. 이 스크립트는 같은 폴더의 build_docs.mjs 를 호출해
//   index.json         : 에이전트/기계용 구조화 메타 + 의존 그래프
//   INDEX.md           : 사람/에이전트용 경량 목차
//   docs.html          : 사람용 단일 브라우징 HTML
//   docs.artifact.html : claude.ai Artifact 발행용 fragment
// 를 생성한다. 산출물은 직접 편집하지 말 것 — .md frontmatter/본문만 고친 뒤 재실행.
//
// 사용: node docs/build.mjs   (Node 22 이상, 내장 모듈만 사용)
//
// Copyright (c) 2026 YWR Labs Inc. All rights reserved.
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// 빌더는 현재 실행 중인 Node 로 자식 프로세스에서 돌린다 — PATH 탐색이 없고, 빌더의 종료 코드와 출력이
// 그대로 전달된다.
const r = spawnSync(process.execPath, [path.join(here, 'build_docs.mjs')], { stdio: 'inherit' })
// 자식 종료 코드를 명시적으로 전파한다 — 중복 id 는 결정론적 빌드 실패이고(ywr-harness ADR 0043), 래퍼가
// 그것을 0 으로 바꾸면 사람이 실행하는 경로에서만 게이트가 사라진다. 시작 실패나 신호 종료는 1 이다.
process.exitCode = r.error ? 1 : (r.status ?? 1)
