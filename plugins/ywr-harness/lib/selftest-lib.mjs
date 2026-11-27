// Shared helpers of the Node suites (ADR 0227 decision 5), the Node side of lib/selftest-lib.ps1.
// A suite imports what it needs:
//   import { fixtureRoot, removeFixtureRoot, runNode, matchFailures, assertMatch } from '../lib/selftest-lib.mjs'
// The pwsh core grew one helper per measured duplicate. This file starts with the three that every
// ported suite needs, and a helper joins it on its second copy.

import { mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, availableParallelism } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

// --- concurrency inside one suite ----------------------------------------------------------------------
// How many jobs a suite runs at once inside itself: between `min` and `cap`, from its share of the CPUs.
// A runner that runs N suites at once sets YWR_SELFTEST_OUTER_JOBS=N for each suite it starts, so N suites
// each take CPUs / N instead of all CPUs each. Alone, the suite takes every CPU.
export function innerJobs(cap, min = 1, outer = process.env.YWR_SELFTEST_OUTER_JOBS) {
  const n = Number.parseInt(String(outer ?? ''), 10)
  const share = Number.isInteger(n) && n > 1 ? Math.floor(availableParallelism() / n) : availableParallelism()
  return Math.max(min, Math.min(cap, share))
}

// --- fixture lifecycle -------------------------------------------------------------------------------
// The root is "<name>-<pid>" under the system temp root, so two concurrent runs never share a tree.
export function fixtureRoot(name) {
  const p = path.join(tmpdir(), `${name}-${process.pid}`)
  mkdirSync(p, { recursive: true })
  return p
}

// True only for a path strictly INSIDE the system temp root: the temp root itself and a repo path given
// by mistake are refused, because the removal below is recursive.
export function isFixturePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false
  let tmp = path.resolve(tmpdir())
  if (!tmp.endsWith(path.sep)) tmp += path.sep
  const full = path.resolve(p)
  const win = process.platform === 'win32'
  return full.length > tmp.length && (win ? full.toLowerCase().startsWith(tmp.toLowerCase()) : full.startsWith(tmp))
}

// YWR_SELFTEST_KEEP_FIXTURE keeps the tree for debugging. Off values are spelled out, so `=0` does not keep.
export function keepFixture(value = process.env.YWR_SELFTEST_KEEP_FIXTURE) {
  if (typeof value !== 'string' || !value.trim()) return false
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

// Removes each fixture path and tolerates a missing one. A refusal is a WARN line, never silent: it
// means that caller leaks its fixture on every run. The refusal is checked before the keep switch, so
// the switch cannot turn a caller bug into a reassuring KEEP line.
export function removeFixtureRoot(...paths) {
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue
    if (!isFixturePath(p)) { console.log(`WARN [fixture]: removeFixtureRoot refused '${p}': not inside ${tmpdir()}`); continue }
    if (keepFixture()) { console.log(`KEEP [fixture]: ${p} (YWR_SELFTEST_KEEP_FIXTURE set — remove it yourself)`); continue }
    // Windows can hold a file of a just-ended child for a moment; four retries, 1 s apart at most.
    try { rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) } catch (e) {
      console.log(`WARN [fixture]: could not remove '${p}': ${e.message}`)
    }
  }
}

// --- Windows 8.3 short names ------------------------------------------------------------------------
// The 8.3 alias of an existing path, such as `C:\Users\RUNNER~1`, or '' when it has none: not Windows, no 8.3
// names on the volume, or the path is its own alias. git never reports a short name, so a case that hands a
// program the alias proves that its path compare reads both spellings as one folder. The GitHub Windows
// runner's TEMP is a short name. The path holds no double quote and no percent sign (cmd reads both).
// cmd prints an internal command in the console code page, which garbles a non-ASCII name, and `chcp 65001`
// does not reach the pipe. `/u` makes it print UTF-16LE. An alias counts only when it names the same real
// folder, so any other print reads as no alias and the case skips.
export function shortAlias(p) {
  if (process.platform !== 'win32') return ''
  const line = `/u /d /s /c "for %I in ("${p}") do @echo %~sI"`
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', [line], { encoding: 'utf16le', windowsVerbatimArguments: true, windowsHide: true })
  const s = r.status === 0 ? String(r.stdout ?? '').trim() : ''
  if (!s) return ''
  try {
    const real = realpathSync.native(p)
    return s.toLowerCase() !== real.toLowerCase() && realpathSync.native(s).toLowerCase() === real.toLowerCase() ? s : ''
  } catch { return '' }
}

// --- child process -----------------------------------------------------------------------------------
// Runs a script with the node that runs the suite. Output is decoded as UTF-8. `input` goes to stdin.
export function runNode(args, { cwd, env, input, timeoutMs } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd, env: env ?? process.env, input, encoding: 'utf8', windowsHide: true,
    timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  })
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

// --- match check ---------------------------------------------------------------------------------------
// The failures of one case, empty when clean. The empty-MustNotMatch guard comes FIRST: a case that
// disallows nothing asserts presence only and stays green against a defect that ADDS output, so an
// empty mustNotMatch needs a stated noNegative reason. preFail holds failures the caller computed.
export function matchFailures(text, { mustMatch = [], mustNotMatch = [], noNegative = '', preFail = [], label = '' } = {}) {
  const fails = []
  if (mustNotMatch.length === 0 && !String(noNegative).trim()) fails.push('no mustNotMatch and no noNegative reason (empty-MustNotMatch class)')
  fails.push(...preFail)
  const pfx = label ? `${label} ` : ''
  const s = String(text ?? '')
  for (const rx of mustMatch) if (!toRx(rx).test(s)) fails.push(`${pfx}missing /${toRx(rx).source}/`)
  for (const rx of mustNotMatch) if (toRx(rx).test(s)) fails.push(`${pfx}unexpected /${toRx(rx).source}/`)
  return fails
}

// A string pattern is a regex source with the semantics of the pwsh -match operand, so a ported pattern
// keeps its verdict: it matches case-insensitively, and a leading inline flag group such as `(?-i)` or
// `(?m)` sets the flags. JavaScript before Node 23 has no inline flag groups, so this function reads the
// leading group and strips it. A flag group later in the pattern stays and fails to compile, loudly. A
// RegExp is used as given.
// Two more .NET rules carry over. The pattern compiles without the `u` flag, so an identity escape such as
// `\-` or `\'` that .NET accepts compiles here too. Without `(?m)`, a final `$` also matches before one
// final newline, as the .NET `$` does. A `$` inside an alternation keeps the JavaScript meaning, so a port
// writes such a pattern with `(?m)` or with `\n?$` in each branch.
export function toRx(p) {
  if (p instanceof RegExp) return p
  let src = String(p)
  const flags = new Set(['i'])
  const m = /^\(\?([imsx]*)(?:-([imsx]+))?\)/u.exec(src)
  if (m) {
    for (const f of m[1]) if (f !== 'x') flags.add(f)
    for (const f of m[2] ?? '') flags.delete(f)
    src = src.slice(m[0].length)
  }
  // An odd count of backslashes before the final `$` escapes it, so the `$` is a literal character.
  const tailSlashes = /(\\*)\$$/u.exec(src)
  if (!flags.has('m') && tailSlashes && tailSlashes[1].length % 2 === 0) src = `${src.slice(0, -1)}(?=\\n?$)`
  return new RegExp(src, [...flags].join(''))
}

// Throws with every failure and the text, so the reporter's FAIL line names the reason and CI shows the output.
export function assertMatch(text, opts) {
  const fails = matchFailures(text, opts)
  if (fails.length) assert.fail(`${fails.join(' · ')}\n--- output ---\n${String(text ?? '')}`)
}
