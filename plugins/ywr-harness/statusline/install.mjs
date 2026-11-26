// Install the harness statusline into the USER scope, so it applies to every Claude Code session
// on this machine rather than one repo. Node 22 or later, built-in modules only (ywr-harness ADR 0220).
//
//   node install.mjs [--claude-dir <dir>] [--dry-run]
//
// Why an installer instead of a plugin component: a plugin cannot contribute the main status line.
// A plugin's `settings.json` supports only `agent` and `subagentStatusLine` (plugins-reference,
// "File locations reference"). The status line is a user-scope setting, so a user-scope writer is
// the only mechanism that exists. ywr-harness ADR 0016 records the decision and the rejected alternatives.
//
// Two effects, and the second is deliberately conservative — it edits a file this script does not
// own, following the same rule ywr-harness ADR 0015 set for `core.hooksPath`:
//
//   1. SCRIPT — `harness-statusline.js` is copied to <user>/.claude/. TOOLCHAIN: overwritten every
//      run, which is how a canon fix reaches this machine.
//   2. WIRING — `statusLine` in <user>/.claude/settings.json:
//        absent                        -> written
//        already pointing at this file -> left alone
//        anything else                 -> REFUSED, existing value reported, nothing changed
//
// Every other key in settings.json is preserved. Exit 0 = installed (with or without a refusal).
// Exit 1 = a CLAUDE_CONFIG_DIR that is set but relative or blank, a canon script missing beside this
// file, a script that could not be placed, or a settings.json that exists and is not a JSON object.
// Exit 2 = a usage error (an unknown flag).
//
// settings.json is read the way the PowerShell original read it (hook-lib parseJsonLoose: comments
// and trailing commas accepted), and the PowerShell semantics the branches rest on are kept: the
// command comparison ignores letter case, and "absent" is PowerShell falsiness (null, false, 0, '',
// an empty array). One difference: two keys of one object that differ only by case are refused as
// unparseable, where the original accepted them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseJsonLoose, isObject, psString, ieq, psJoin, whichOnPath } from '../hooks/hook-lib.mjs'

const say = (line) => process.stdout.write(line + '\n')

function main() {
  let args
  try {
    args = parseArgs({
      options: { 'claude-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
      strict: true, allowPositionals: false,
    }).values
  } catch (e) {
    say(`FAIL — ${e.message}`)
    say('usage: node install.mjs [--claude-dir <dir>] [--dry-run]')
    return 2
  }
  const dryRun = args['dry-run']
  const here = path.dirname(fileURLToPath(import.meta.url))

  // Resolve the default target (ywr-harness ADR 0046). When omitted, the default is the user scope THIS
  // SESSION runs under: CLAUDE_CONFIG_DIR when set, else ~/.claude. A default that ignored the env var
  // installed into a directory a config-dir session never reads — silently, which looks identical to
  // "the plugin did nothing". An explicit --claude-dir is trusted verbatim; the env var is NOT — a
  // relative or blank-but-set value (an unexpanded '$HOME/.claude', a stray './cfg') would resolve
  // against whatever directory this script was run FROM, recreating exactly the silent wrong-dir
  // install this default exists to prevent. A value this script cannot interpret is refused loudly,
  // the same posture as the foreign-statusLine refusal below.
  let claudeDir = args['claude-dir']
  if (claudeDir === undefined) {
    const rawCfg = process.env.CLAUDE_CONFIG_DIR ?? ''
    if (rawCfg) {
      const trimCfg = rawCfg.trim()
      if (!trimCfg || !isRooted(trimCfg)) {
        say(`FAIL — CLAUDE_CONFIG_DIR ('${rawCfg}') is not an absolute path; refusing to resolve it against the current directory. Fix the variable or pass --claude-dir.`)
        return 1
      }
      claudeDir = trimCfg
    } else {
      claudeDir = psJoin(os.homedir(), '.claude')
    }
  }

  const SCRIPT_NAME = 'harness-statusline.js'
  const src = path.join(here, SCRIPT_NAME)
  if (!isFile(src)) {
    say(`FAIL — canon not found next to install.mjs (looked for ${src})`)
    return 1
  }

  if (!isDir(claudeDir)) {
    if (dryRun) say(`would create ${claudeDir}`)
    else fs.mkdirSync(claudeDir, { recursive: true })
  }
  const dst = psJoin(claudeDir, SCRIPT_NAME)

  say(`harness statusline -> ${claudeDir}${dryRun ? ' (dry run — nothing written)' : ''}`)

  // --- 1. the script -----------------------------------------------------------------------------
  // Compared byte for byte, in order: a same-length reordered copy is a changed copy.
  let scriptState = 'unchanged'
  if (isFile(dst)) {
    if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) scriptState = 'refreshed'
  } else {
    scriptState = 'created'
  }
  if (scriptState !== 'unchanged' && !dryRun) {
    try { fs.copyFileSync(src, dst) }
    catch (e) { say(`  FAIL ${SCRIPT_NAME} — ${e.message}`); return 1 }
  }
  say(`  script: ${SCRIPT_NAME} ${scriptState}`)

  // --- 2. the wiring -----------------------------------------------------------------------------
  // node is what runs the line. Absent node is REPORTED, not silent: the setting would be written and
  // the status line would simply never render, which looks identical to "the plugin did nothing".
  if (!whichOnPath('node')) say('  note: node is not on PATH — the status line will not render until it is')

  const settingsPath = psJoin(claudeDir, 'settings.json')
  const wanted = `node "${dst}"`
  const manualSnippet = () =>
    say(`  Add this yourself:  "statusLine": { "type": "command", "command": "${wanted.replace(/\\/g, '\\\\')}" }`)

  let settings
  if (isFile(settingsPath)) {
    const rawText = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '')
    if (!rawText.trim()) {
      settings = {}
    } else {
      try {
        settings = parseJsonLoose(rawText)
      } catch (e) {
        // Refusing here is the point: rewriting a file we could not parse would destroy settings.
        say(`  FAIL settings.json does not parse — refusing to rewrite it: ${e.message}`)
        manualSnippet()
        return 1
      }
      // Valid JSON is not enough: `[]`, `null`, `"x"` and `3` cannot carry a statusLine key. The same
      // refusal, the same exit.
      if (!isObject(settings)) {
        say('  FAIL settings.json is valid JSON but not an object — refusing to rewrite it')
        manualSnippet()
        return 1
      }
    }
  } else {
    settings = {}
  }

  const current = Object.prototype.hasOwnProperty.call(settings, 'statusLine') ? settings.statusLine : null
  const currentCmd = isObject(current) ? psString(current.command) : ''

  // The block this script writes is the command alone. Through v0.62.1 it also carried
  // `refreshInterval: 30` (ywr-harness ADR 0059); ywr-harness ADR 0122 dropped it: the payload's rate_limits come from the
  // session's own API responses (ywr-harness fact 97), and the one segment that can move while a session idles — the
  // installed plugin version, read from disk as a restart signal — can wait for the next exchange. A refreshInterval
  // already on our block is left as it is — whether this script or the member put it there cannot be told apart
  // (the ywr-harness ADR 0015 rule, same as the foreign-statusLine refusal below) — and the run says so instead of
  // keeping quiet.
  if (!psTruthy(current)) {
    if (dryRun) {
      say('  wiring: statusLine absent — would set it')
    } else {
      settings.statusLine = { type: 'command', command: wanted }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2).replace(/\n/g, os.EOL) + os.EOL, 'utf8')
      say('  wiring: statusLine set — wired')
    }
  } else if (ieq(currentCmd, wanted)) {
    // current is necessarily an object here — currentCmd is only non-empty for one.
    say('  wiring: statusLine already points here — already wired')
    if (Object.prototype.hasOwnProperty.call(current, 'refreshInterval')) {
      const kept = current.refreshInterval === null ? 'null' : psString(current.refreshInterval)
      say(`          refreshInterval ${kept} kept — no longer wired (ywr-harness ADR 0122); delete it from settings.json if you did not set it yourself`)
    }
  } else {
    // Same rule as ywr-harness ADR 0015's hooksPath: a value this script did not write is a decision it cannot
    // see the reasons for.
    say('  wiring: statusLine is already set to something else — REFUSED to change it')
    say(`          existing: ${currentCmd}`)
    say(`          wanted:   ${wanted}`)
    say('          Edit settings.json yourself if you meant to switch.')
  }
  return 0
}

// .NET Path.IsPathRooted: on Windows a drive letter or a leading separator, elsewhere a leading '/'.
function isRooted(p) {
  return process.platform === 'win32' ? /^([A-Za-z]:|[\\/])/.test(p) : p.startsWith('/')
}

function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }

// PowerShell truthiness of a parsed JSON value: an object is true even when empty, an array is the
// truthiness of its one element or true for two or more, a number is true when not 0.
function psTruthy(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? psTruthy(v[0]) : true
  return true
}

process.exitCode = main()
