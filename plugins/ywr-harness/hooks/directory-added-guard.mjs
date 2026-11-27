// DirectoryAdded guard: reports a working directory that the session added mid-run (ywr-harness spec 0006 §3.1).
// No matcher, because the event matcher filters on `source` and a future third source value would bypass the guard.
// Visibility only. The event has no decision control and fires after the permission refresh, so the directory is already live.
// Payload: `directory` (absolute path) and `source` ("slash_command" or "register_repo_root").
// The reader is Claude, not the person, so the banner is English and asks the model to relay one sentence (ywr-harness ADR 0097).
// Always exit 0: a failed hook shows only as a failure count or in the debug log.
// A payload with no usable `directory` emits a SCHEMA DRIFT banner, so a guard that reads a wrong field never goes silent.
// The two settings keys that an added directory contributes are parsed for, never inferred from the file existing.
// An unparseable settings file is reported as unknown, never as absent.
// Payload text is echoed through inline() (hook-lib.mjs), so a hostile value cannot forge a second `[hook:*]` line.
// Matching is case-insensitive and the directory is trimmed like .NET Trim; the settings reader drops a BOM,
// decodes UTF-16 by its BOM and parses leniently via parseJsonLoose (ywr-harness ADR 0116, ywr-harness spec 0006 §3.1).
// The hook returns instead of calling process.exit, so stdout drains.
import fs from 'node:fs'
import path from 'node:path'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, inline, emit, driftKeys } from './hook-lib.mjs'

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:dir-added] SCHEMA DRIFT — the DirectoryAdded payload's 'directory' field is missing, empty or not a string, so this guard cannot report which directory was added to the session. Keys received: ${keys}. The hooks reference's DirectoryAdded input may have changed. In your next reply, tell the user in one sentence, in their language, that this is a ywr-harness plugin defect to report with /ywr-harness:report-issue.` })
}

// A UTF-8 BOM is dropped and a UTF-16 BOM selects the decoding. Throws when the file cannot be read.
function readText(file) {
  const b = fs.readFileSync(file)
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le')
  let s = b.toString('utf8')
  if (s.startsWith(String.fromCharCode(0xfeff))) s = s.slice(1)
  return s
}

// The top-level key names of a settings file. An empty file names no key, and a one-element array reads as its element.
function settingsKeys(file) {
  const text = readText(file)
  if (!netTrim(text)) return []
  let cfg = parseJsonLoose(text)
  if (Array.isArray(cfg) && cfg.length === 1) cfg = cfg[0]
  return isObject(cfg) ? Object.keys(cfg) : []
}

function main(payload) {
  // The raw directory drives the filesystem checks. Drift is judged on what the banner would echo:
  // a value of only control bytes or backticks echoes as nothing, and a non-string `directory` is a shape change.
  const rawDir = getProp(payload, 'directory')
  const dir = typeof rawDir === 'string' ? netTrim(rawDir) : ''
  // A `source` that is present but not a string is named as such, never folded into 'absent'.
  const rawSrc = getProp(payload, 'source')
  let src = typeof rawSrc === 'string' ? inline(rawSrc) : ''
  if (!src) src = rawSrc !== undefined && rawSrc !== null ? '(source not a string)' : '(source absent)'

  if (!inline(dir)) return drift(payload)

  // What the addition pulls in, per the permissions reference table "Additional directories grant file access,
  // not configuration". The exceptions apply to --add-dir and /add-dir only, never to permissions.additionalDirectories.
  const loads = []
  const unparsed = []
  const instr = []
  const instrLocal = []
  const has = rel => fs.existsSync(path.join(dir, rel))   // never throws; false for an unusable path or root
  try {
    if (has('.claude/skills')) loads.push('skills from .claude/skills (live reload)')
    if (has('.claude/commands')) loads.push('command files from .claude/commands (no live reload; a same-named command of this project wins)')
    if (has('.claude/agents')) loads.push('subagent definitions from .claude/agents — they answer bare names, so a spawn naming worker instead of ywr-harness:worker gets that tree\'s model/effort, not the harness pin')
    const keysFound = []
    for (const s of ['.claude/settings.json', '.claude/settings.local.json']) {
      if (!has(s)) continue
      try {
        const present = settingsKeys(path.join(dir, s))
        for (const k of ['enabledPlugins', 'extraKnownMarketplaces']) {
          if (present.some(p => ieq(p, k)) && !keysFound.includes(k)) keysFound.push(k)
        }
      } catch { unparsed.push(s) }
    }
    if (keysFound.length) loads.push(`${keysFound.join(' + ')} from its settings (the only settings keys an added directory contributes)`)

    // CLAUDE.local.md is listed apart because the reference gives it a second precondition.
    for (const p of ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules']) {
      if (has(p)) instr.push(p)
    }
    if (has('CLAUDE.local.md')) instrLocal.push('CLAUDE.local.md')
  } catch { /* a probe failure leaves what was found so far */ }

  // The permissions reference gates the merge on `=1`. Any other value reads as unset: telling the model
  // files are NOT in context when they are costs one extra read; the reverse leaves it without them.
  const mdEnvSet = netTrim(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD ?? '') === '1'
  const parts = [`[hook:dir-added] ${inline(dir, 300)} was added as a working directory of this session (source: ${src}).`]
  parts.push('Files under it are now readable and editable by your tools; a context-isolation rule stated in any CLAUDE.md is convention, not enforcement, so do not carry content from that tree into this project unless the user asks.')
  parts.push('Do not assume this project\'s gates cover it: its git hooks never run for a commit in the added tree (that repository\'s own hooks do), and its Claude Code hooks still fire on your tool calls there but may skip or misjudge paths outside CLAUDE_PROJECT_DIR — run that tree\'s own checks when you change files there.')
  if (loads.length) parts.push(`Loaded from it: ${loads.join(' · ')}.`)
  if (unparsed.length) parts.push(`${unparsed.join(', ')} could not be parsed, so whether it contributes enabledPlugins or extraKnownMarketplaces is UNKNOWN, not absent.`)
  if (instr.length) {
    const found = instr.join(', ')
    if (mdEnvSet) parts.push(`Instruction files present (${found}) and CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 — they MERGE into this session's prompt.`)
    else parts.push(`Instruction files present (${found}), but CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is not 1, so they are NOT in your context — read them before working in that tree.`)
  }
  if (instrLocal.length) {
    if (mdEnvSet) parts.push('CLAUDE.local.md is present and the env var is 1, but it merges only while the \'local\' setting source is also enabled (the default) — one precondition more than the other instruction files.')
    else parts.push('CLAUDE.local.md is present and, for the same reason (env var not 1), NOT in your context.')
  }
  parts.push('In your next reply, tell the user in one sentence, in their language, that this directory was added and that this project\'s checks may not cover edits there; if they did not mean to add it, /permissions removes it.')
  emit({ systemMessage: parts.join(' ') })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'DirectoryAdded')) main(payload)
} catch { /* fail-open: a hook defect is never a failed directory add */ }
