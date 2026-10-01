// DirectoryAdded (NO matcher — the matcher for this event filters on `source`, and a
// guard must not be bypassable by a future third source value) — mid-session
// working-directory registration guard.
//
// Visibility ONLY, by construction: DirectoryAdded carries no decision control and
// fires AFTER the sandbox/permission refresh, so the directory is already live when
// this runs. Blocking would need a permissions deny rule instead (deliberately not
// taken).
//
// Payload (hooks reference "DirectoryAdded input", re-read raw 2026-09-27 on 2.1.283; first
// read out of the 2.1.220 binary's zod schema before the event was documented):
//   directory : absolute path of the directory that was added
//   source    : "slash_command" (/add-dir) | "register_repo_root" (SDK control request)
//
// THE READER IS CLAUDE, NOT THE PERSON (ADR 0097). Per the reference, a `slash_command`
// systemMessage is delivered "to Claude as context on the next conversation turn, rather than
// showing it to you", and a `register_repo_root` one goes to the debug log only. So the banner
// is English (ADR 0045's reader rule, narrowed by ADR 0097), states what the model should do,
// and asks it to relay one sentence to the user. The hook runs in the background after the add
// has completed; a failed hook shows only as a failure COUNT in the transcript (/add-dir) or not at
// all (register_repo_root), its output going to the debug log — so always exit 0.
//
// Anti-vacuity: a DirectoryAdded payload with no `directory` emits a SCHEMA-DRIFT
// banner listing the keys actually received, rather than failing open into silence.
// The sibling config-change-audit hook read an invented field name and was silently
// inert while its selftest stayed green — a guard that cannot report its
// own drift is indistinguishable from an absent guard.
//
// Existence is not selection (review finding, medium): the two settings keys an added
// directory can contribute are PARSED for, not inferred from the settings file merely
// existing — a `.claude/settings.json` holding only hooks or permissions contributes
// nothing, and claiming otherwise would be the same existence-vs-selection confusion
// this slice exists to retire. An unparseable settings file is reported as unknown,
// never as absent (REVIEW.md #4).
//
// Payload-authored text is echoed through inline() (hook-lib.mjs: C0, DEL, U+0085 NEL,
// U+2028/U+2029 and the backtick become a space, then a hard cap), so a hostile value cannot forge
// a second `[hook:*]` line in the banner the model reads.
//
// Ported from PowerShell (ADR 0116) with its semantics kept: the event name is compared
// case-insensitively, payload keys and the settings keys are matched case-insensitively (PSCustomObject
// access and `-contains` were), the directory is trimmed with .NET Trim semantics, and the instruction
// env var is trimmed the same way. A settings file loses its BOM before parsing (Get-Content did), and a
// UTF-16 one is decoded by its BOM; an empty file or a one-element array reads as ConvertFrom-Json read
// it (settingsKeys). Deliberate deviations (spec 0006 §3.1): a payload string stays a
// string (no DateTime coercion) and the drift key order is Intl.Collator's. A settings file is parsed
// as leniently as ConvertFrom-Json did (hook-lib's parseJsonLoose: comments, trailing commas, single
// quotes, unquoted keys). The hook never exits the process: it returns, so
// stdout drains and the exit code stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, inline, emit } from './hook-lib.mjs'

// Drift-key order: case-insensitive, locale-aware (the original's Sort-Object was culture-aware), with
// an ordinal tiebreak so the order is deterministic (same rule as agent-model-warn.mjs).
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

function drift(payload) {
  let keys = '(none)'
  const k = Object.keys(payload).sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
  if (k.length) keys = inline(k.join(', '), 300)
  emit({ systemMessage: `[hook:dir-added] SCHEMA DRIFT — the DirectoryAdded payload's 'directory' field is missing, empty or not a string, so this guard cannot report which directory was added to the session. Keys received: ${keys}. The hooks reference's DirectoryAdded input may have changed. In your next reply, tell the user in one sentence, in their language, that this is a ywr-harness plugin defect to report with /ywr-harness:feedback.` })
}

// A settings file's text the way Get-Content -Raw read it: a UTF-8 BOM is dropped, a UTF-16 BOM selects
// the decoding. Throws when the file cannot be read (the caller reports it as unparsed).
function readText(file) {
  const b = fs.readFileSync(file)
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le')
  let s = b.toString('utf8')
  if (s.startsWith(String.fromCharCode(0xfeff))) s = s.slice(1)
  return s
}

// The top-level key names of a settings file, which the caller matches case-insensitively. As with
// ConvertFrom-Json: an empty or whitespace-only file parses to nothing (no keys, not an error), and a
// one-element array is unwrapped to its element; any other non-object result names no key.
function settingsKeys(file) {
  const text = readText(file)
  if (!netTrim(text)) return []
  let cfg = parseJsonLoose(text)
  if (Array.isArray(cfg) && cfg.length === 1) cfg = cfg[0]
  return isObject(cfg) ? Object.keys(cfg) : []
}

function main(payload) {
  // The raw directory drives the filesystem checks; drift is judged on what the banner would echo
  // (a value of only control bytes or backticks survives Trim() but echoes as nothing), and a
  // non-string `directory` is a shape change — both are drift.
  const rawDir = getProp(payload, 'directory')
  const dir = typeof rawDir === 'string' ? netTrim(rawDir) : ''
  // A `source` that is present but not a string is named as such, never folded into 'absent'.
  const rawSrc = getProp(payload, 'source')
  let src = typeof rawSrc === 'string' ? inline(rawSrc) : ''
  if (!src) src = rawSrc !== undefined && rawSrc !== null ? '(source not a string)' : '(source absent)'

  if (!inline(dir)) return drift(payload)

  // What the addition actually pulls in, per the official permissions reference table
  // "Additional directories grant file access, not configuration" (5 rows, re-read 2026-09-27;
  // the `.claude/commands` row was absent from the 2026-07-25 read). Note the table's own caveat:
  // these exceptions apply to --add-dir / /add-dir only, NOT to permissions.additionalDirectories,
  // which grants file access and nothing else.
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

    // CLAUDE.local.md is listed apart because the reference gives it a SECOND
    // precondition the others do not have (review finding, low).
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
