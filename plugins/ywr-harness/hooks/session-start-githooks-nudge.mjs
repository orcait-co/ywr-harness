// SessionStart git-hooks wiring nudge, suggest-only (ywr-harness ADR 0029). It writes nothing,
// not git config and not files (ywr-harness ADR 0015).
//
// It registers WITHOUT a matcher on purpose. The event fires at startup and again on
// resume, clear, compact and fork. A wired clone is silent on every source, and speaking again
// after `compact` re-injects a fact that summaries lose.
//
// Output: `additionalContext` joins the model's context and `systemMessage` shows to the user.
// Plain stdout on exit 0 also becomes context, so every non-speaking path prints nothing.
// SessionStart cannot block. The hook exits 0 always and fails open.
//
// It speaks ONLY when the work tree root carries `.githooks/` and `core.hooksPath` is unset in
// this clone. A foreign value stays silent by design (ywr-harness ADR 0029).
//
// A payload with no `cwd` emits a SCHEMA-DRIFT banner with the keys received, never silence:
// a guard that cannot report its own drift looks like an absent guard.
//
// Both git calls follow the git subprocess boundary (ywr-harness ADR 0223): `-c core.quotepath=false`,
// a bytes pipe, one explicit UTF-8 decode, no shell. The hook never exits the process, so stdout
// drains and the exit code stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun, gitPrefetch, driftKeys, markerAbove } from './hook-lib.mjs'

// Every failure, such as a root that does not exist on this platform or an illegal path, reads as "not there".
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

const git = gitRun

// The first output line, trimmed ('' when there is none).
function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:githooks-nudge] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 이 클론의 git 훅이 연결되어 있는지 확인할 수 없습니다. 수신된 키: ${keys}. 페이로드 형식을 다시 확인하고 hooks/session-start-githooks-nudge.mjs을 수정하세요 (ywr-harness ADR 0029).` })
}

async function main(payload) {
  const cwd = netTrim(psString(getProp(payload, 'cwd')))
  if (!cwd) return drift(payload)
  // No `.githooks/` from cwd upward: nothing to say, and no git starts.
  if (!markerAbove(cwd, '.githooks')) return
  // The root read and the clone's config read start at once (ywr-harness ADR 0236). Both name the same repo.
  const topArgs = ['-C', cwd, 'rev-parse', '--show-toplevel']
  const cfgArgs = ['-C', cwd, 'config', '--local', '--get', 'core.hooksPath']
  await gitPrefetch([topArgs, cfgArgs])

  // Resolve the work tree root from cwd so a subdirectory session finds the repo. A failed
  // resolution (not a work tree, vanished cwd) is silent. With no git, `.githooks/` at the cwd
  // marks a repo that expects hooks, so the verdict is reported as UNKNOWN, never passed silently.
  const top = git(topArgs)
  if (top.absent) {
    if (isDir(path.join(cwd, '.githooks'))) {
      emit({ systemMessage: '[hook:githooks-nudge] .githooks/ 는 있지만 이 환경에서 git을 실행할 수 없어, 이 클론에 core.hooksPath가 연결되어 있는지는 UNKNOWN, 확인되지 않았습니다.' })
    }
    return
  }
  const root = firstLine(top.text)
  if (top.status !== 0 || !root) return

  if (!isDir(path.join(root, '.githooks'))) return
  // A cloned repo's directory name is attacker-authorable and a model reads this output: echo it flattened.
  const rootShow = inline(root, 300)

  // `--local` on purpose: the per-clone value decides whether hooks run HERE (ywr-harness ADR 0015).
  // Any non-empty value, wired or foreign, is silent. Only a clean unset verdict nudges, and
  // exit 1 is git's not-found code. Any other outcome is UNKNOWN, reported as such and never
  // turned into a nudge. That covers a non-0/non-1 exit and an empty value at exit 0.
  const cfg = git(cfgArgs)
  const cfgExit = cfg.status === null ? -1 : cfg.status
  if (firstLine(cfg.text)) return
  if (cfgExit !== 1) {
    emit({ systemMessage: `[hook:githooks-nudge] ${rootShow} 에는 .githooks/ 가 있지만 이 클론의 core.hooksPath를 정상적으로 읽을 수 없습니다 (git config exit ${cfgExit}, 값 없음) — 연결 여부 UNKNOWN, 확인되지 않았습니다.` })
    return
  }

  const cmd = 'git config core.hooksPath .githooks'
  const sys = `[hook:githooks-nudge] ${rootShow} 에는 .githooks/ 가 있지만 이 클론의 core.hooksPath가 UNSET입니다 — 이 환경에서는 어떤 git 훅도 실행되지 않습니다 (pre-commit 게이트, pre-push secret scan). 연결하려면: ${cmd} — 또는 조건부로 연결하는 /ywr-harness:harness-init을 다시 실행하세요 (ywr-harness ADR 0015). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0029).`
  const ctx = `The repo at ${rootShow} ships .githooks/ (pre-commit gates, pre-push secret scan) but this clone's core.hooksPath is unset, so none of it runs locally; CI still gates the content, so the cost is feedback latency (ywr-harness ADR 0015). When the work turns commit-shaped, offer the user the wiring one-liner: ${cmd}. Do not run it unasked — this surface is suggest-only (ywr-harness ADR 0029).`
  emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) await main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
