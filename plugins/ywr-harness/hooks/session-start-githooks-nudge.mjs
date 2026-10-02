// SessionStart (registered WITHOUT a matcher, deliberately — the event DOES support one, on
// `source`; the unwired condition below is the filter) — git-hooks wiring nudge, suggest-only
// (ADR 0029).
//
// The gap this closes is temporal, not informational: ADR 0015's `hooks:` drift line prints at
// slice close and in CI, i.e. AFTER the work. This hook moves the same fact to the start of the
// session on the unwired machine — before the first commit that would have skipped the gates.
//
// Suggest-only is the contract, not a phase (ADR 0029): 0015 rejected a SessionStart hook that
// SETS core.hooksPath because of the mutation, and that objection does not reach a hook that only
// speaks. This hook writes nothing, ever — not git config, not files.
//
// Payload and output contract, verified against the official hooks reference 2026-08-05
// (code.claude.com/docs/en/hooks.md — read RAW; a summarized read of the same page reported the
// matcher as absent and the slice review's raw grep showed the opposite, the exact class
// REVIEW.md's raw-source rule exists for):
//   cwd    : working directory of this firing (one per firing; the event fires at startup and
//            AGAIN on resume/clear/compact/fork — not once per session)
//   source : startup | resume | clear | compact | fork — the event supports a matcher on this
//            field; this hook registers WITHOUT one on purpose: a wired clone is silent on
//            every source, and re-speaking after `compact` deliberately re-injects a fact
//            summaries lose. Filtering a source out later is a one-line hooks.json matcher,
//            not a script change.
// The runtime consumes BOTH `hookSpecificOutput.additionalContext` (joins the model's context)
// and `systemMessage` (shown to the user) for this event; plain stdout on exit 0 also becomes
// context, which is why every non-speaking path prints NOTHING. SessionStart cannot block
// anything; this hook does not try — exit 0 always, fail-open like its siblings.
//
// Decision table (ADR 0029): speak ONLY when the resolved work tree root carries `.githooks/`
// AND `core.hooksPath` is unset in this clone. A foreign value is silent BY DESIGN — that state
// is a decision (0015 refuses to clobber it for the same reason), and an unsilenceable
// per-session nag was judged worse than the residual drift, which the emitter still reports.
//
// Anti-vacuity (the directory-added-guard rule): a SessionStart payload with no `cwd` emits a
// SCHEMA-DRIFT banner listing the keys actually received, rather than failing open into silence —
// a guard that cannot report its own drift is indistinguishable from an absent guard.
//
// Port notes (ADR 0116): the pwsh original is this file's reference. Event-name comparison, key
// lookup and the [string] cast keep PowerShell's semantics through hook-lib (case-insensitive
// lookup/compare, psString, .NET Trim). An absent git is detected by hook-lib's gitRun (no git on PATH, or ENOENT) — the
// original asked `Get-Command git`. Both git calls follow CLAUDE.md's git subprocess boundary
// (issue #40): `-c core.quotepath=false`, a BYTES pipe, one explicit UTF-8 decode, no shell, no
// text-mode newline handling. The hook never exits the process: it returns, so stdout drains and
// the exit code stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun, driftKeys } from './hook-lib.mjs'

// Test-Path -PathType Container, promoted so every failure (a root that does not exist on this
// platform, an illegal path) reads as "not there".
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// git calls go through hook-lib's gitRun (PATH-resolved, absolute spawn, bytes decoded once).
const git = gitRun

// The first output line, trimmed ('' when there is none): the original took lines[0].Trim().
function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:githooks-nudge] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 이 클론의 git 훅이 연결되어 있는지 확인할 수 없습니다. 수신된 키: ${keys}. 페이로드 형식을 다시 확인하고 hooks/session-start-githooks-nudge.mjs을 수정하세요 (ADR 0029).` })
}

function main(payload) {
  const cwd = netTrim(psString(getProp(payload, 'cwd')))
  if (!cwd) return drift(payload)

  // Resolve the work tree root from cwd so a subdirectory session still finds the repo. A failed
  // resolution (not a work tree, vanished cwd) is silent: no repo, no hooks story. No git, no
  // verdict — but `.githooks/` sitting at the cwd is a repo that EXPECTS hooks, so unknown is
  // reported rather than silently passed (the emitter's hooks_status posture).
  const top = git(['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.absent) {
    if (isDir(path.join(cwd, '.githooks'))) {
      emit({ systemMessage: '[hook:githooks-nudge] .githooks/ 는 있지만 이 환경에서 git을 실행할 수 없어, 이 클론에 core.hooksPath가 연결되어 있는지는 UNKNOWN, 확인되지 않았습니다.' })
    }
    return
  }
  const root = firstLine(top.text)
  if (top.status !== 0 || !root) return

  if (!isDir(path.join(root, '.githooks'))) return
  // A directory name is attacker-authorable text (a cloned repo's) and a model reads this output: echo it flattened.
  const rootShow = inline(root, 300)

  // `--local` on purpose: the per-clone value is the one that decides whether hooks run HERE, and
  // it is the value ADR 0015's wiring table reasons about. Any non-empty value — wired or foreign —
  // is silent (decision table above). Only a CLEAN unset verdict nudges: exit 1 is git's
  // documented not-found code; any other outcome — a non-0/non-1 exit (unreadable config) or an
  // empty value at exit 0 — is UNKNOWN, reported as such and never resolved into an actionable
  // nudge (the no-git branch's posture; review 2026-08-05, low).
  const cfg = git(['-C', root, 'config', '--local', '--get', 'core.hooksPath'])
  const cfgExit = cfg.status === null ? -1 : cfg.status
  if (firstLine(cfg.text)) return
  if (cfgExit !== 1) {
    emit({ systemMessage: `[hook:githooks-nudge] ${rootShow} 에는 .githooks/ 가 있지만 이 클론의 core.hooksPath를 정상적으로 읽을 수 없습니다 (git config exit ${cfgExit}, 값 없음) — 연결 여부 UNKNOWN, 확인되지 않았습니다.` })
    return
  }

  const cmd = 'git config core.hooksPath .githooks'
  const sys = `[hook:githooks-nudge] ${rootShow} 에는 .githooks/ 가 있지만 이 클론의 core.hooksPath가 UNSET입니다 — 이 환경에서는 어떤 git 훅도 실행되지 않습니다 (pre-commit 게이트, pre-push secret scan). 연결하려면: ${cmd} — 또는 조건부로 연결하는 /ywr-harness:harness-init을 다시 실행하세요 (ADR 0015). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0029).`
  const ctx = `The repo at ${rootShow} ships .githooks/ (pre-commit gates, pre-push secret scan) but this clone's core.hooksPath is unset, so none of it runs locally; CI still gates the content, so the cost is feedback latency (ADR 0015). When the work turns commit-shaped, offer the user the wiring one-liner: ${cmd}. Do not run it unasked — this surface is suggest-only (ADR 0029).`
  emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
