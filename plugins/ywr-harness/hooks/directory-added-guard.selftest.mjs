// Self-test for directory-added-guard.mjs (harness-scope gate).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/directory-added-guard.selftest.mjs
//
// Fixture provenance matters here: the payload shape asserted below is the hooks reference's
// "DirectoryAdded input" (re-read 2026-09-27; first read out of the 2.1.220 binary's zod
// schema). An invented shape is exactly how
// the sibling config-change-audit hook stayed green while being inert, so cases 1 and 2
// are ground truth, not guesses. Every case carries MustNotMatch as well as MustMatch —
// an assertion set with no negatives is the empty-MustNotMatch class this repo has hit
// three times, with follow-ups tracked.
//
// Case 3's `rich` fixture carries exactly ONE of the two plugin keys because the first draft
// asserted the OPPOSITE (review medium): it wrote an EMPTY settings.json and demanded the banner
// claim both keys anyway, freezing an existence-vs-selection overclaim as the expected answer.
// Case 3 now proves the guard names what is there and stays silent about what is not; cases 6-7
// (a settings file with neither key, an unparseable one) come from the same review.
//
// The banner's reader is CLAUDE, not the person (ADR 0097: an /add-dir systemMessage is next-turn
// model context, a register_repo_root one a debug-log line), so it is English — cases 1 and 10
// refuse any Hangul in the guard's own prose — and it carries a relay instruction to the model.
//
// Port notes (ADR 0227). The pwsh suite named its cases without IDs, apart from R1. Each test here is
// `DA<n> <the old name>`, numbered in file order, so the parity check of ADR 0227 decision 8 matches the
// names. The comments keep the case numbers of the pwsh suite. Patterns are pwsh -match sources
// (case-insensitive; see toRx in lib/selftest-lib.mjs). The environment variable of cases 4-9 is set per
// hook call, never in the suite's own process, so no case leaks it into another. Every special
// character of the class under test is built from a code point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { matchFailures, fixtureRoot, removeFixtureRoot } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'directory-added-guard.mjs')
const ch = (...c) => String.fromCharCode(...c)
const esc = s => s.replace(/[\\*+?|{[()^$.#\s]/g, '\\$&')   // regex.Escape of .NET, for the characters a path carries
const MD_VAR = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'

// stdin as pwsh piped it: the text plus one newline. stdout and stderr together, as `2>&1` read them.
// `md` is the value of MD_VAR for this one call; undefined removes it from the child's environment.
function invokeHook(stdin, md) {
  const env = { ...process.env }
  delete env[MD_VAR]
  if (md !== undefined) env[MD_VAR] = md
  const r = spawnSync(process.execPath, [hook], { input: Buffer.from(stdin + '\n', 'utf8'), env, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}
const payload = fields => JSON.stringify({ hook_event_name: 'DirectoryAdded', ...fields })

// The empty-MustNotMatch guard and the match loops live in the shared helper; what is file-specific is
// the envelope.
function sysMsgFailures({ out, exit }, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — fail-open contract; a non-zero exit sends output to the debug log)`)
  let msg = ''
  try { msg = String(JSON.parse(out.trim()).systemMessage ?? '') } catch { pre.push('stdout is not valid JSON') }
  if (!msg) pre.push('no systemMessage (the only field this event consumes)')
  return matchFailures(msg, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'systemMessage' })
}
function assertSysMsg(r, mustMatch, mustNotMatch) {
  const f = sysMsgFailures(r, mustMatch, mustNotMatch)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}
function assertEmptyStdout({ out, exit }) {
  const f = []
  if (exit !== 0) f.push(`exit ${exit} (want 0 — fail-open contract)`)
  if (out.trim()) f.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(f, [], f.join(' · '))
}

// --- fixtures: one tree under the system temp root, removed when the suite's process ends -----------------
const fx = fixtureRoot('dag-selftest')
process.on('exit', () => removeFixtureRoot(fx))
const mk = (tag, ...sub) => {
  const p = path.join(fx, tag)
  mkdirSync(p, { recursive: true })
  for (const s of sub) mkdirSync(path.join(p, s), { recursive: true })
  return p
}
const bare = mk('bare')
const rich = mk('rich', '.claude/skills', '.claude/agents')
const plain = mk('plain', '.claude')
const cmds = mk('cmds', '.claude/commands')
const broken = mk('broken', '.claude')
const localmd = mk('localmd')
// exactly ONE of the two contributing keys, so the banner must name it and omit the other
writeFileSync(path.join(rich, '.claude/settings.json'), '{"extraKnownMarketplaces":{}}')
writeFileSync(path.join(rich, 'CLAUDE.md'), '# other project')
// a settings file with NO contributing key — the common real-world shape
writeFileSync(path.join(plain, '.claude/settings.json'), '{"hooks":{},"permissions":{"allow":[]}}')
writeFileSync(path.join(broken, '.claude/settings.json'), '{ not json at all')
writeFileSync(path.join(localmd, 'CLAUDE.local.md'), '# local only')

const bareRx = esc(bare)
const richRx = esc(rich)
const noExist = path.join(tmpdir(), 'dag-no-such-dir')   // platform-neutral: a literal `C:\x` is a NON-EXISTENT DRIVE on Linux CI

// 1. /add-dir of a plain directory -> banner names the path + source, states BOTH
//    consequences and the relay instruction, in English (its reader is the model, ADR 0097);
//    nothing claimed about config it does not have
test('DA1 slash_command bare dir', () => {
  assertSysMsg(invokeHook(payload({ directory: bare, source: 'slash_command' })),
    [String.raw`\[hook:dir-added\]`, bareRx, 'source: slash_command', 'convention, not enforcement',
      "Do not assume this project's gates cover it", 'CLAUDE_PROJECT_DIR', 'git hooks never run for a commit in the added tree',
      'still fire on your tool calls there', 'checks may not cover edits there',
      'In your next reply, tell the user in one sentence, in their language', '/permissions removes it'],
    ['SCHEMA DRIFT', 'Loaded from it', 'Instruction files present', 'UNKNOWN', String.raw`[\uAC00-\uD7A3]`, 'checked by neither'])
})

// 2. SDK control-request source is reported as itself, not folded into /add-dir
test('DA2 register_repo_root source', () => {
  assertSysMsg(invokeHook(payload({ directory: bare, source: 'register_repo_root' })),
    ['source: register_repo_root'], ['slash_command', 'SCHEMA DRIFT'])
})

// 3. the config surfaces that DO load are named, and ONLY the settings key actually
//    present is claimed (permissions reference table, 5 rows at the 2026-09-27 re-read)
test('DA3 config surfaces enumerated', () => {
  assertSysMsg(invokeHook(payload({ directory: rich, source: 'slash_command' })),
    [richRx, String.raw`skills from \.claude/skills`, String.raw`subagent definitions from \.claude/agents`,
      'extraKnownMarketplaces from its settings', 'they answer bare names', 'instead of ywr-harness:worker'],
    ['SCHEMA DRIFT', 'enabledPlugins', 'UNKNOWN', 'command files from'])
})

// 3a. command files load from an added directory too (the reference table's fifth row,
//     absent from the guard until ADR 0097's re-read) — named alone when alone
test('DA4 command files enumerated', () => {
  assertSysMsg(invokeHook(payload({ directory: cmds, source: 'slash_command' })),
    [String.raw`command files from \.claude/commands`, 'same-named command of this project wins'],
    ['skills from', 'subagent definitions', 'SCHEMA DRIFT', 'UNKNOWN'])
})

// 4. instruction files present, env var unset -> reported as NOT joining the prompt
test('DA5 CLAUDE.md present, env unset', () => {
  assertSysMsg(invokeHook(payload({ directory: rich, source: 'slash_command' })),
    [String.raw`Instruction files present \(CLAUDE\.md\)`, 'NOT in your context — read them before working in that tree'], ['MERGE'])
})

// 5. same directory, env var set -> the severity flips to a prompt merge
test('DA6 CLAUDE.md present, env set', () => {
  assertSysMsg(invokeHook(payload({ directory: rich, source: 'slash_command' }), '1'),
    ['MERGE into this session'], ['NOT in your context'])
})

// 5a. the reference gates the merge on `=1`: a set-but-not-1 value (0, the usual way to switch a
//     flag off) must NOT be reported as a merge — the model would assume instructions it lacks
test('DA7 env var 0 is not a merge', () => {
  assertSysMsg(invokeHook(payload({ directory: rich, source: 'slash_command' }), '0'),
    ['is not 1, so they are NOT in your context'], ['MERGE'])
})

// 6. EXISTENCE IS NOT SELECTION (review medium): a settings file carrying neither
//    contributing key must produce NO configuration claim at all
test('DA8 settings file without the two keys claims nothing', () => {
  assertSysMsg(invokeHook(payload({ directory: plain, source: 'slash_command' })),
    ['was added as a working directory'], ['enabledPlugins', 'extraKnownMarketplaces', 'Loaded from it', 'UNKNOWN'])
})

// 7. an unparseable settings file is UNKNOWN, never silently absent (the canon review invariant 4)
test('DA9 unparseable settings reports unknown', () => {
  assertSysMsg(invokeHook(payload({ directory: broken, source: 'slash_command' })),
    ['UNKNOWN, not absent', String.raw`settings\.json`], ['Loaded from it', 'SCHEMA DRIFT'])
})

// 7a. settings KEYS match case-insensitively (the original's `-contains` did), and a UTF-8 BOM in front of
//     the file does not make it unparseable (Get-Content dropped it; a Windows editor writes one) — a BOM
//     read as garbage would report a real file as UNKNOWN.
test('DA10 BOM-prefixed settings with case-drifted keys is parsed, names both keys', () => {
  const ci = mk('ci', '.claude')
  writeFileSync(path.join(ci, '.claude/settings.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ENABLEDPLUGINS":{},"extraknownmarketplaces":{}}', 'utf8')]))
  assertSysMsg(invokeHook(payload({ directory: ci, source: 'slash_command' })),
    [String.raw`(?-i)enabledPlugins \+ extraKnownMarketplaces from its settings`], ['UNKNOWN', 'SCHEMA DRIFT'])
})

// 7b. an EMPTY settings file parses to nothing — no keys, no claim, and not UNKNOWN (ConvertFrom-Json
//     emitted nothing for it); a UTF-16 file (Windows PowerShell 5.1's default redirect encoding) is
//     decoded by its BOM rather than reported as unparseable.
test('DA11 empty settings file claims nothing and is not UNKNOWN', () => {
  const emp = mk('emp', '.claude')
  writeFileSync(path.join(emp, '.claude/settings.json'), Buffer.alloc(0))
  assertSysMsg(invokeHook(payload({ directory: emp, source: 'slash_command' })),
    ['was added as a working directory'], ['Loaded from it', 'UNKNOWN', 'enabledPlugins', 'SCHEMA DRIFT'])
})
test('DA12 UTF-16 settings file is decoded by its BOM', () => {
  const u16 = mk('u16', '.claude')
  writeFileSync(path.join(u16, '.claude/settings.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"enabledPlugins":{}}', 'utf16le')]))
  assertSysMsg(invokeHook(payload({ directory: u16, source: 'slash_command' })),
    ['(?-i)enabledPlugins from its settings'], ['UNKNOWN', 'extraKnownMarketplaces', 'SCHEMA DRIFT'])
})

// 7c. a settings file with comments, a trailing comma, a single-quoted string and an unquoted key parses as
//     ConvertFrom-Json parsed it (hook-lib parseJsonLoose) — not UNKNOWN; a `#` comment, which
//     ConvertFrom-Json refused too, still reports UNKNOWN.
test('DA13 commented settings file with trailing commas is parsed, names both keys', () => {
  const cmt = mk('cmt', '.claude')
  const lf = ch(10)
  writeFileSync(path.join(cmt, '.claude/settings.json'),
    '{' + lf + '  // plugins this project turns on' + lf + '  "enabledPlugins": { \'x@y\': true, },' + lf + '  /* block */ extraKnownMarketplaces: {},' + lf + '}')
  assertSysMsg(invokeHook(payload({ directory: cmt, source: 'slash_command' })),
    [String.raw`(?-i)enabledPlugins \+ extraKnownMarketplaces from its settings`], ['UNKNOWN', 'SCHEMA DRIFT'])
})
test('DA14 a # comment is still unparseable (ConvertFrom-Json refused it too)', () => {
  const hsh = mk('hsh', '.claude')
  const lf = ch(10)
  writeFileSync(path.join(hsh, '.claude/settings.json'), '{ # not a JSON comment' + lf + ' "enabledPlugins": {} }')
  assertSysMsg(invokeHook(payload({ directory: hsh, source: 'slash_command' })),
    ['UNKNOWN, not absent'], ['enabledPlugins from its settings', 'SCHEMA DRIFT'])
})

// 8. CLAUDE.local.md carries a SECOND precondition the other instruction files do
//    not (review low) — env set: merges only while the local settings source is on
test('DA15 CLAUDE.local.md extra precondition, env set', () => {
  assertSysMsg(invokeHook(payload({ directory: localmd, source: 'slash_command' }), '1'),
    [String.raw`CLAUDE\.local\.md is present`, "'local' setting source", 'one precondition more'],
    ['Instruction files present', 'SCHEMA DRIFT'])
})

// 9. env unset -> the local-source caveat is irrelevant and must not be stated
test('DA16 CLAUDE.local.md, env unset', () => {
  assertSysMsg(invokeHook(payload({ directory: localmd, source: 'slash_command' })),
    ['NOT in your context'], ["'local' setting source", 'one precondition more'])
})

// 10. ANTI-VACUITY: the field this guard reads is renamed/absent -> it must SAY SO,
//     not fall silent. This is the case the sibling hook lacked (it read an invented
//     `config_source` and every real payload made it exit 0 quietly).
test('DA17 schema drift is reported, not swallowed', () => {
  assertSysMsg(invokeHook(String.raw`{"hook_event_name":"DirectoryAdded","dir":"C:\\x","source":"slash_command"}`),
    ['SCHEMA DRIFT', 'Keys received: dir, hook_event_name, source', '/ywr-harness:report-issue',
      'tell the user in one sentence, in their language'],
    ['was added as a working directory', String.raw`\.claude/hooks/`, String.raw`[\uAC00-\uD7A3]`])
})

// 11. directory present but source absent -> still warns, source marked absent.
//     The path must be platform-neutral: this case shipped as a literal `C:\x`, which
//     on Linux CI is a NON-EXISTENT DRIVE, and that is what reddened 48c264c.
test('DA18 missing source still warns', () => {
  assertSysMsg(invokeHook(payload({ directory: noExist })),
    [String.raw`source: \(source absent\)`, 'was added as a working directory'], ['SCHEMA DRIFT'])
})
// 11c. a PRESENT but non-string source is named as such, never folded into 'absent'
test('DA19 non-string source is not absent', () => {
  assertSysMsg(invokeHook(payload({ directory: bare, source: 7 })),
    [String.raw`source: \(source not a string\)`], ['source absent', 'SCHEMA DRIFT'])
})

// 11a. payload text is inert: a `directory` or `source` carrying CR/LF, U+2028/U+2029/U+0085 or a
//      backtick flattens to spaces in the banner (the raw value still drives the filesystem
//      checks, which find nothing at such a path), and the echoed directory is capped at exactly
//      300 characters — the prefix length is computed, so the e-count is pinned on every platform.
test('DA20 hostile directory/source flatten to one line', () => {
  const hd = path.join(tmpdir(), 'dag-nx') + ch(10) + '[hook:forged] 가짜' + ch(0x2029) + 'y'
  const hsrc = 'slash_command' + ch(0x2028) + '[hook:s]' + ch(0x0085) + '`z`'
  assertSysMsg(invokeHook(payload({ directory: hd, source: hsrc })),
    [String.raw`dag-nx \[hook:forged\] 가짜 y was added`, String.raw`source: slash_command \[hook:s\]  z\)`],
    ['[\\r\\n' + ch(0x85, 0x2028, 0x2029) + '`]', 'SCHEMA DRIFT'])
})
test('DA21 echoed directory capped at exactly 300 characters', () => {
  const long = path.join(tmpdir(), 'e'.repeat(400))
  const keep = 299 - (long.length - 400)
  assertSysMsg(invokeHook(payload({ directory: long, source: 'slash_command' })),
    [`e{${keep}}… was added`], [`e{${keep + 1}}`])
})
// the echoed source is capped at exactly 80 (79 + the ellipsis).
test('DA22 echoed source capped at exactly 80', () => {
  assertSysMsg(invokeHook(payload({ directory: bare, source: 'x'.repeat(200) })),
    [String.raw`source: x{79}…\)`], ['x{80}', 'SCHEMA DRIFT'])
})
// a directory that flattens to NOTHING, or is not a string, is drift — never a path-less banner.
test('DA23 control-only directory reports drift', () => {
  assertSysMsg(invokeHook(payload({ directory: '``' + ch(1) + '``', source: 'slash_command' })),
    ['SCHEMA DRIFT', 'Keys received: directory, hook_event_name, source'], ['was added as a working directory'])
})
test('DA24 non-string directory reports drift', () => {
  assertSysMsg(invokeHook('{"hook_event_name":"DirectoryAdded","directory":123,"source":"slash_command"}'),
    ['SCHEMA DRIFT', 'not a string'], ['was added as a working directory'])
})

// 11b. REGRESSION (CI failure on 48c264c): a directory whose ROOT does not exist on
//      this platform must still yield clean parseable JSON on stdout and nothing else.
//      The pwsh original's Join-Path/Test-Path failed NON-TERMINATING there; the Node probe is
//      fs.existsSync, which answers false for an unusable root, so there is no stderr to leak.
//      The bogus root is chosen per platform so the case reproduces on both, which the original
//      Windows-only run could not do.
test('DA25 unresolvable root emits clean JSON only', () => {
  let bogusRoot = 'C:\\no-such-root\\x'
  if (process.platform === 'win32') {
    // the first drive letter from E to Z that names no drive
    const free = [...Array(26 - 4).keys()].map(i => String.fromCharCode(69 + i)).find(L => !existsSync(`${L}:\\`))
    bogusRoot = `${free}:\\no-such-root\\x`
  }
  assertSysMsg(invokeHook(payload({ directory: bogusRoot, source: 'slash_command' })),
    ['was added as a working directory', "Do not assume this project's gates cover it"],
    ['SCHEMA DRIFT', 'Cannot find drive', 'Loaded from it', 'UNKNOWN'])
})

// 12. a path that no longer exists on disk -> banner, no crash, no invented config
test('DA26 vanished path does not crash', () => {
  assertSysMsg(invokeHook(payload({ directory: path.join(bare, 'gone-subdir'), source: 'slash_command' })),
    ['was added as a working directory'], ['SCHEMA DRIFT', 'Loaded from it', 'UNKNOWN'])
})

// 13. UTF-8 BOM prefixed stdin -> still parses (config-change-audit incident 07-23:
//     TrimStart alone is not enough without InputEncoding set to UTF8 first)
test('DA27 BOM-prefixed stdin', () => {
  assertSysMsg(invokeHook(ch(0xfeff) + payload({ directory: bare, source: 'slash_command' })), [bareRx], ['SCHEMA DRIFT'])
})

// 13a. PSCustomObject member access and `-ne` were case-insensitive in the original; the port keeps both:
//      case-drifted KEYS and a lowercase event name still read (a case-sensitive lookup would see no
//      `directory` and report drift). The drift key list sorts case-insensitively too.
test('DA28 case-drifted keys and a lowercase event name still guard', () => {
  assertSysMsg(invokeHook(JSON.stringify({ Hook_Event_Name: 'directoryadded', DIRECTORY: bare, Source: 'register_repo_root' })),
    [bareRx, 'source: register_repo_root'], ['SCHEMA DRIFT'])
})
test('DA29 drift key list sorts case-insensitively', () => {
  assertSysMsg(invokeHook('{"hook_event_name":"DirectoryAdded","zeta":1,"Alpha":2,"beta":3}'),
    [String.raw`Keys received: Alpha, beta, hook_event_name, zeta\.`], ['was added as a working directory'])
})
// 13b. a trimmed directory: .NET Trim() semantics (padding spaces and U+00A0 drop; the filesystem checks
//      run on the trimmed path, so a padded real directory is still enumerated)
test('DA30 padded directory is trimmed and still enumerated', () => {
  assertSysMsg(invokeHook(payload({ directory: '  ' + rich + ch(0xa0), source: 'slash_command' })),
    [String.raw`skills from \.claude/skills`, 'extraKnownMarketplaces from its settings'], ['SCHEMA DRIFT', 'UNKNOWN'])
})

// 14. wrong event name -> silent (defensive event guard, symmetric with siblings)
test('DA31 wrong event silent', () => {
  assertEmptyStdout(invokeHook(String.raw`{"hook_event_name":"CwdChanged","directory":"C:\\x","source":"slash_command"}`))
})

// 15. garbage stdin -> silent exit 0 (infra failure is not a finding)
test('DA32 garbage fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{')) })

// Inline(): the hook owns no copy — it imports hook-lib.mjs's inline(), the one class every Node hook
// shares (hook-lib.selftest.mjs holds that function's behaviour). The flattening cases above (11a) are
// behavioural through the real hook. A local Inline/inline would split the class again.
test('DA33 inline() is imported from hook-lib.mjs and the hook defines no Inline/inline of its own', () => {
  const src = readFileSync(hook, 'utf8')
  const importsInline = /^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*'\.\/hook-lib\.mjs'/mu.test(src)
  const ownCopy = /\bfunction\s+inline\b|\b(?:const|let|var)\s+inline\b/iu.test(src)
  assert.ok(importsInline && !ownCopy, `imports inline from hook-lib: ${importsInline} · defines its own: ${ownCopy}`)
})

// R1. REGISTRATION. Every case above pipes a payload straight into the script, so none of them sees whether
//     the runtime ever calls it. This pins the wiring: DirectoryAdded with NO matcher (the matcher for this
//     event filters on `source`, and the guard must not be bypassable by a future third value), exec-form
//     node <script> (ADR 0116). That it FIRES is a live probe's to show.
test('R1 hooks.json registers this script once: DirectoryAdded, no matcher, exec-form node <script>', () => {
  const fails = []
  try {
    const hj = JSON.parse(readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/directory-added-guard\.(ps1|mjs)/iu.test(parts.join(' '))) sites.push({ ev, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/directory-added-guard.mjs']
    if (sites.length !== 1) fails.push(`want exactly 1 registration of directory-added-guard (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s1 = sites[0]
      const gotArgs = [s1.h.args ?? []].flat().map(String)
      if (s1.ev !== 'DirectoryAdded') fails.push(`event '${s1.ev}' (want DirectoryAdded)`)
      if (s1.matcher) fails.push(`matcher '${s1.matcher}' (want none — a matcher on source is bypassable)`)
      if (String(s1.h.type) !== 'command' || String(s1.h.command) !== 'node') fails.push(`handler type/command '${s1.h.type}'/'${s1.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) fails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//u, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) fails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s1.h.timeout) !== '15') fails.push(`timeout '${s1.h.timeout}' (want 15)`)
    }
  } catch (e) { fails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(fails, [], fails.join(' · '))
})

// META — every case above already carried a negative (the file's header rule), so the
// empty-MustNotMatch guard is PREVENTIVE here. This case is what keeps a preventive guard from
// being deleted with nothing turning red. The guard lives in the shared helper, so what is
// proven here is this file's WIRING to it: a wrapper that dropped the mustNotMatch passthrough
// would leave the helper intact and every case in this file unguarded.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
test('DA34 META', () => {
  const f = sysMsgFailures(metaOut, ['meta probe'], [])
  assert.ok(f.length === 1 && /no mustNotMatch/iu.test(f[0]), `guard did not fire — reason='${f.join('; ')}'`)
})
test('DA35 META exemption honored', () => {
  const f = sysMsgFailures(metaOut, ['meta probe'], [], 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed')
  assert.deepEqual(f, [], '-NoNegative exemption rejected')
})
