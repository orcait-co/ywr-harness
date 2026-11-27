// Installs the harness statusline into the user scope, so it applies to every Claude Code session on
// this machine. Node 22 or later, built-in modules only (ywr-harness ADR 0220).
//
//   node install.mjs [--claude-dir <dir>] [--dry-run]
//
// An installer, not a plugin component, because a plugin cannot contribute the main status line
// (ywr-harness ADR 0016). Two effects. The second edits a file this script does not own, so it is
// conservative (the rule of ywr-harness ADR 0015 for `core.hooksPath`):
//   1. SCRIPT: copies `harness-statusline.js` to <claude-dir>, overwritten every run so a canon fix
//      reaches this machine.
//   2. WIRING: sets `statusLine` in <claude-dir>/settings.json.
//        absent                        -> written
//        already pointing at this file -> left alone
//        anything else                 -> REFUSED, existing value reported, nothing changed
//
// Every other key in settings.json is preserved. Exit 0 = installed, with or without a refusal.
// Exit 1 = a CLAUDE_CONFIG_DIR that is set but relative or blank, a canon script missing beside this
// file, a script that could not be placed, or a settings.json that exists and is not a JSON object.
// Exit 2 = a usage error (an unknown flag).
//
// settings.json is read by hook-lib parseJsonLoose: comments and trailing commas pass, and two keys of
// one object that differ only by case are refused as unparseable. The command comparison ignores
// letter case. "Absent" is PowerShell falsiness: null, false, 0, '' or an empty array.

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

  // Default target: CLAUDE_CONFIG_DIR when set, else ~/.claude (ywr-harness ADR 0046). An explicit
  // --claude-dir is trusted verbatim. The env var is not: a relative or blank value, such as an
  // unexpanded '$HOME/.claude', would resolve against the directory the script runs from and install
  // where no session reads. Such a value is refused loudly.
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
  // Node runs the line. A missing node is reported, because the status line would never render and
  // that looks like "the plugin did nothing".
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
        // Rewriting a file that did not parse would destroy settings.
        say(`  FAIL settings.json does not parse — refusing to rewrite it: ${e.message}`)
        manualSnippet()
        return 1
      }
      // `[]`, `null`, `"x"` and `3` are valid JSON that cannot carry a statusLine key.
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

  // The block written is the command alone, with no `refreshInterval` (ywr-harness ADR 0122,
  // ywr-harness fact 97). A `refreshInterval` already on the block stays: the script cannot tell its own write from
  // the member's. The run reports it.
  if (!psTruthy(current)) {
    if (dryRun) {
      say('  wiring: statusLine absent — would set it')
    } else {
      settings.statusLine = { type: 'command', command: wanted }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2).replace(/\n/g, os.EOL) + os.EOL, 'utf8')
      say('  wiring: statusLine set — wired')
    }
  } else if (ieq(currentCmd, wanted)) {
    // currentCmd is non-empty only for an object, so `current` is an object here.
    say('  wiring: statusLine already points here — already wired')
    if (Object.prototype.hasOwnProperty.call(current, 'refreshInterval')) {
      const kept = current.refreshInterval === null ? 'null' : psString(current.refreshInterval)
      say(`          refreshInterval ${kept} kept — no longer wired (ywr-harness ADR 0122); delete it from settings.json if you did not set it yourself`)
    }
  } else {
    // A value this script did not write is the member's decision (ywr-harness ADR 0015).
    say('  wiring: statusLine is already set to something else — REFUSED to change it')
    say(`          existing: ${currentCmd}`)
    say(`          wanted:   ${wanted}`)
    say('          Edit settings.json yourself if you meant to switch.')
  }
  return 0
}

// Rooted means a drive letter or a leading separator on Windows, a leading '/' elsewhere.
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
