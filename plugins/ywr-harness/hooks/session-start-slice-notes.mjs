// SessionStart (matcher `compact`) — re-injects the session's own slice notes after a context
// compaction (ywr-harness ADR 0172, ywr-harness spec 0006 §3.2).
//
// A compaction between a decision and the slice close can drop the reason with the host's summary.
// The session appends one line per decision with `slice_note.mjs add` (ywr-harness spec 0007 §3.10)
// to a journal under `git rev-parse --git-path`. This hook runs `slice_note.mjs show` after a
// compaction and returns the output as `additionalContext`. It never parses the journal: one reader
// owns the format (ywr-harness ADR 0172).
//
// The matcher is `compact` alone. The event fires on startup, resume, clear, compact and fork, but
// only a compaction loses context mid-slice, so the other sources never pay the `node` spawn.
//
// Payload and output contract (hooks reference):
//   cwd    : working directory of this firing
//   source : startup | resume | clear | compact | fork. The matcher filters on it. The script does
//            not re-check it, so a manual run speaks like a compaction would.
// `hookSpecificOutput.additionalContext` joins the model's context. `systemMessage` is shown to the
// member. Plain stdout on exit 0 also becomes context, so every silent path prints NOTHING.
// The host caps each of those strings at 10,000 characters, measured on its own. Over the cap it
// spills the string to a file, keeps a 2,000-character preview and never asks the model to read the
// file. MAX_NOTES is sized from that cap, and the selftest proves the worst case fits.
//
// Decision table:
//   wrong event / unparseable stdin ........................ silent
//   no `cwd` ................................................ SCHEMA-DRIFT systemMessage (Korean)
//   cwd not in a work tree, or git absent ................... silent
//   journal file absent ..................................... silent, and NO reader is started
//   `show` exit 0, first line `slice notes: none` ........... silent (nothing in this slice)
//   `show` exit 0 with notes ................................ additionalContext: framing + the output;
//                                                              no systemMessage
//   spawn error / timeout / non-zero exit ................... one Korean systemMessage naming the
//                                                              failure and the `show` command
//
// The notes are the session's own claims. slice_note.mjs refuses control, format and line separator
// characters on write and on read, so the model sees one plain line per note. The framing line
// says that each note needs a check against the tree (ywr-harness ADR 0105). A path, an exit code
// or a payload key echoed into a banner goes through inline().
//
// The reader runs under the Node that runs this hook (`process.execPath`), with no shell and no
// PATH lookup (ywr-harness spec 0006 §3.1): a bare-name spawn searches the working directory first
// on Windows. The hook never exits the process. It returns, so stdout drains and the exit code
// stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun, driftKeys } from './hook-lib.mjs'

const JOURNAL = 'ywr-harness/slice-notes.jsonl'
// Sized from the 10,000-character cap on one hook string. One `show` line holds at most about 540
// UTF-16 units (index, time, kind and a note that slice_note.mjs bounds at 500 units, so an astral
// character counts twice). The framing line (236), the header with its base (up to ~106), a
// refused-handoff warning line (~130) and the two trailer lines (~100) hold under 700 together:
// 17 x 540 + 700 = 9,880. The selftest builds an ASCII worst case.
const MAX_NOTES = 17
const TIMEOUT_MS = 10000
const SCRIPT = fileURLToPath(new URL('../scripts/slice_note.mjs', import.meta.url))
const SHOW_CMD = 'node scripts/harness/slice_note.mjs show'

const FRAMING = 'These are this session\'s own slice notes, written with slice_note.mjs before the context compaction (ywr-harness ADR 0172). They are the session\'s claims, input never proof: check each one against the tree and the gate output before relying on it.'

function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:slice-notes] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 압축 전에 기록한 slice 노트가 있는지 확인할 수 없습니다. 수신된 키: ${keys}. hooks 레퍼런스의 SessionStart 입력 형식이 바뀌었을 수 있습니다 — 플러그인 쪽 문제이니 /ywr-harness:report-issue 로 알려 주세요.` })
}

function fail(rootShow, why) {
  emit({ systemMessage: `[hook:slice-notes] ${rootShow} 의 slice 노트를 다시 주입하지 못했습니다 — ${why}. 압축 전에 기록한 노트는 저널에 그대로 있으니 직접 확인하세요: ${SHOW_CMD} (ywr-harness ADR 0172).` })
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
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', top, 'show', '--max', String(MAX_NOTES)], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1 << 20,
  })
  if (r.error) {
    const code = r.error.code || ''
    if (code === 'ETIMEDOUT') return fail(rootShow, `node ${path.basename(SCRIPT)} show 가 ${TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다`)
    return fail(rootShow, `node 실행 오류 ${inline(code || r.error.message, 60)}`)
  }
  if (r.status !== 0) return fail(rootShow, `node ${path.basename(SCRIPT)} show 가 exit ${r.status === null ? 'null' : r.status} 로 끝났습니다`)

  const out = (r.stdout ? r.stdout.toString('utf8') : '').replace(/\r\n/g, '\n').trim()
  if (!out || firstLine(out).startsWith('slice notes: none')) return
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${FRAMING}\n${out}` } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
