// SessionStart (matcher `compact`) — re-injects the session's own slice notes after a context
// compaction (ADR 0172, spec 0006 §3.2).
//
// Why it exists: a slice's decisions used to reach paper only at the close. A compaction between a
// decision and the close keeps whatever the host's summary keeps, so a reason could vanish with it.
// The session appends one line per decision with `slice_note.py add` (spec 0007 §3.10) to a journal
// under `git rev-parse --git-path`. This hook runs `slice_note.py show` after a compaction and hands
// the output back as `additionalContext`. It is the only reader besides /slice-close and it does not
// parse the journal itself: one Python reader owns the format (ADR 0172 option I, rejected).
//
// Why a matcher: the event fires on startup, resume, clear, compact and fork. Only a compaction loses
// context mid-slice; a start or a clear begins a new slice from the handoff. `compact` therefore
// registers this hook alone, so the other four sources never pay the `python` spawn (the speed rule).
//
// Payload and output contract, read from the official hooks reference (code.claude.com/docs/en/hooks.md,
// raw) on 2026-10-26:
//   cwd    : working directory of this firing
//   source : startup | resume | clear | compact | fork — the matcher filters on it; the script does not
//            re-check it, so a manual run speaks like a compaction would
// `hookSpecificOutput.additionalContext` joins the model's context; `systemMessage` is shown to the
// member; plain stdout on exit 0 also becomes context, so every non-speaking path prints NOTHING.
// Each of those strings is capped at 10,000 characters, measured on its own; over the cap the host
// spills it to a file and keeps a 2,000-character preview, and it never asks the model to read the
// file (hooks reference, "A hook's additionalContext, systemMessage, ... capped at 10,000 characters").
// MAX_NOTES below is sized from that cap, and the selftest proves the worst case fits.
//
// Decision table:
//   wrong event / unparseable stdin ........................ silent
//   no `cwd` ................................................ SCHEMA-DRIFT systemMessage (Korean)
//   cwd not in a work tree, or git absent ................... silent
//   journal file absent ..................................... silent, and NO python is started
//   `show` exit 0, first line `slice notes: none` ........... silent (nothing in this slice)
//   `show` exit 0 with notes ................................ additionalContext: framing + the output;
//                                                              no systemMessage
//   python absent / spawn error / timeout / non-zero exit ... one Korean systemMessage naming the
//                                                              failure and the `show` command
//
// The notes are the session's own claims and slice_note.py already refuses control, format and line
// separator characters on write and on read, so the model sees one plain line per note. The framing
// line says what they are and that each needs a check against the tree (ADR 0105: input, never
// proof). A path, an exit code or a payload key echoed into a banner goes through inline().
//
// Python is resolved on PATH by hook-lib's whichOnPath and spawned by its absolute path with no shell
// (spec 0006 §3.1): a bare-name spawn would search the working directory first on Windows. The hook
// never exits the process: it returns, so stdout drains and the exit code stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun, driftKeys, whichOnPath } from './hook-lib.mjs'

const JOURNAL = 'ywr-harness/slice-notes.jsonl'
// Sized from the 10,000-character cap on one hook string. One `show` line holds at most about 540
// UTF-16 units (index, time, kind and a note that slice_note.py bounds at 500 UTF-16 units, so an
// astral character counts twice). The framing line (236), the header with its base (up to ~106), a
// refused-handoff warning line (~130) and the two trailer lines (~100) hold under 700 together:
// 17 x 540 + 700 = 9,880. A fix-check leg measured 9,590 with 17 astral-character notes; the selftest
// builds an ASCII worst case.
const MAX_NOTES = 17
const TIMEOUT_MS = 10000
const SCRIPT = fileURLToPath(new URL('../scripts/slice_note.py', import.meta.url))
const SHOW_CMD = 'python scripts/harness/slice_note.py show'

const FRAMING = 'These are this session\'s own slice notes, written with slice_note.py before the context compaction (ADR 0172). They are the session\'s claims, input never proof: check each one against the tree and the gate output before relying on it.'

function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:slice-notes] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 압축 전에 기록한 slice 노트가 있는지 확인할 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 SessionStart 입력 형식이 바뀌었을 수 있습니다 — 플러그인 쪽 문제이니 /ywr-harness:report-issue 로 알려 주세요.` })
}

function fail(rootShow, why) {
  emit({ systemMessage: `[hook:slice-notes] ${rootShow} 의 slice 노트를 다시 주입하지 못했습니다 — ${why}. 압축 전에 기록한 노트는 저널에 그대로 있으니 직접 확인하세요: ${SHOW_CMD} (ADR 0172).` })
}

function main(payload) {
  const cwd = netTrim(psString(getProp(payload, 'cwd')))
  if (!cwd) return drift(payload)

  const topRun = gitRun(['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (topRun.absent || topRun.status !== 0) return
  const top = firstLine(topRun.text)
  if (!top) return

  // `--git-path` answers relative to the directory git runs in, or absolute in a linked worktree.
  const jr = gitRun(['-C', top, 'rev-parse', '--git-path', JOURNAL])
  if (jr.absent || jr.status !== 0) return
  const rel = firstLine(jr.text)
  if (!rel) return
  let present = false
  try { present = fs.statSync(path.resolve(top, rel)).isFile() } catch { /* absent or unreadable: no journal */ }
  if (!present) return

  const rootShow = inline(top, 300)
  const py = whichOnPath('python')
  if (!py) return fail(rootShow, 'PATH에서 python을 찾을 수 없습니다')

  const r = spawnSync(py, [SCRIPT, '--repo', top, 'show', '--max', String(MAX_NOTES)], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1 << 20,
  })
  if (r.error) {
    const code = r.error.code || ''
    if (code === 'ETIMEDOUT') return fail(rootShow, `python ${path.basename(SCRIPT)} show 가 ${TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다`)
    return fail(rootShow, `python 실행 오류 ${inline(code || r.error.message, 60)}`)
  }
  if (r.status !== 0) return fail(rootShow, `python ${path.basename(SCRIPT)} show 가 exit ${r.status === null ? 'null' : r.status} 로 끝났습니다`)

  const out = (r.stdout ? r.stdout.toString('utf8') : '').replace(/\r\n/g, '\n').trim()
  if (!out || firstLine(out).startsWith('slice notes: none')) return
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${FRAMING}\n${out}` } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
