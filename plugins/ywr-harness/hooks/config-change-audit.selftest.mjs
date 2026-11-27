// Self-test for config-change-audit.mjs (harness-scope gate).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/config-change-audit.selftest.mjs
//
// Cases CC1 and CC2 use the field that the event carries (`source`). Case CC7 pins the wrong name `config_source`:
// a payload lacking `source` must produce a drift banner, never silence, because a fixture with an invented field name stays green while the hook never fires.
// Patterns go through toRx in lib/selftest-lib.mjs, which matches case-insensitively.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { matchFailures } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'config-change-audit.mjs')
const ch = (...c) => String.fromCharCode(...c)

// stdin is the text plus one newline. The result joins stdout and stderr.
function invokeHook(stdin) {
  const r = spawnSync(process.execPath, [hook], { input: Buffer.from(stdin + '\n', 'utf8'), windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}

// stdout is a JSON envelope, and ConfigChange honors only `systemMessage`. The checks read the banner text.
function systemMessageFailures({ out, exit }, mustMatch, mustNotMatch, noNegative = '') {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — fail-open contract)`)
  let msg = ''
  try { msg = String(JSON.parse(out.trim()).systemMessage ?? '') } catch { pre.push('stdout is not valid JSON') }
  if (!msg) pre.push('no systemMessage (the only field this event consumes)')
  return matchFailures(msg, { mustMatch, mustNotMatch, noNegative, preFail: pre, label: 'systemMessage' })
}
function assertSystemMessage(r, mustMatch, mustNotMatch) {
  const f = systemMessageFailures(r, mustMatch, mustNotMatch)
  assert.deepEqual(f, [], `${f.join(' · ')}\n--- output ---\n${r.out}`)
}
function assertEmptyStdout({ out, exit }) {
  const f = []
  if (exit !== 0) f.push(`exit ${exit} (want 0 — fail-open contract)`)
  if (out.trim()) f.push(`expected empty stdout, got: ${out.trim()}`)
  assert.deepEqual(f, [], f.join(' · '))
}

// 1. real payload shape: the systemMessage names the changed tier (a banner for the person)
test('CC1 audit systemMessage', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"project_settings"}'),
    [String.raw`\[hook:config-audit\] project_settings 세션 중 변경됨`, '명시적인 사용자 승인'], ['SCHEMA DRIFT'])
})
// 2. an optional file_path is surfaced when present, because it names which file the tier does not
test('CC2 file_path surfaced', () => {
  assertSystemMessage(invokeHook(String.raw`{"hook_event_name":"ConfigChange","source":"local_settings","file_path":"C:\\p\\.claude\\settings.local.json"}`),
    ['local_settings 세션 중 변경됨', String.raw`settings\.local\.json`], ['SCHEMA DRIFT'])
})
// 3. garbage stdin: silent exit 0, because unparseable input is infrastructure, not drift
test('CC3 garbage fail-open', () => { assertEmptyStdout(invokeHook('not json at all {{{')) })
// 4. wrong event name: silent (a defensive event guard, as in the sibling hooks)
test('CC4 wrong event silent', () => {
  assertEmptyStdout(invokeHook('{"hook_event_name":"SessionStart","source":"project_settings"}'))
})
// 5. stdin with a UTF-8 BOM prefix still parses
test('CC5 BOM-prefixed stdin', () => {
  assertSystemMessage(invokeHook(ch(0xfeff) + '{"hook_event_name":"ConfigChange","source":"project_settings"}'),
    [String.raw`\[hook:config-audit\] project_settings 세션 중 변경됨`], ['SCHEMA DRIFT'])
})
// 6. a whitespace-only source is drift, never a tier-less banner and never silence
test('CC6 whitespace source reports drift', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"  "}'),
    ['SCHEMA DRIFT', '수신된 키: hook_event_name, source'], ['세션 중 변경됨'])
})
// 7. regression: a payload carrying `config_source` and no `source` is reported as drift, naming the keys it got.
test('CC7 old config_source name is reported as drift', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","config_source":"project_settings"}'),
    ['SCHEMA DRIFT', '수신된 키: config_source, hook_event_name', '/ywr-harness:report-issue'],
    [String.raw`\[hook:config-audit\] project_settings`, String.raw`\.claude/hooks/`])
})
// 8. payload text is inert: CR/LF, U+2028, U+2029, U+0085 and backticks in `source` flatten to spaces, so
//    a hostile value cannot forge a second `[hook:*]` line. `file_path` is capped at exactly 300
//    characters: its 5-character prefix leaves 294 d's before the ellipsis, and 293 or 295 fails.
test('CC8 hostile source/file_path flatten to one line; file_path capped at 300', () => {
  const hs = 'project_settings' + ch(13, 10) + '[hook:forged]' + ch(0x2028) + '가짜' + ch(0x85) + '`x`'
  const hp = 'C:\\p\\' + 'd'.repeat(400) + ch(0x2029) + '[hook:x]'
  assertSystemMessage(invokeHook(JSON.stringify({ hook_event_name: 'ConfigChange', source: hs, file_path: hp })),
    [String.raw`\[hook:config-audit\] project_settings  \[hook:forged\] 가짜  x 세션 중 변경됨`, String.raw`\(C:\\p\\d{294}…\)`],
    [String.raw`[\r\n\u0085\u2028\u2029` + '`]', 'd{295}'])
})
// 9. the echoed source is capped at exactly 80 (79 + the ellipsis).
test('CC9 echoed source capped at exactly 80', () => {
  assertSystemMessage(invokeHook(JSON.stringify({ hook_event_name: 'ConfigChange', source: 'y'.repeat(200) })),
    [String.raw`\] y{79}… 세션 중 변경됨`], ['y{80}', 'SCHEMA DRIFT'])
})
// 10. a source that flattens to nothing (control bytes and backticks only) or is not a string is drift,
//     never a tier-less banner.
test('CC10 control-only source reports drift', () => {
  assertSystemMessage(invokeHook(JSON.stringify({ hook_event_name: 'ConfigChange', source: '``' + ch(1) + '``' })),
    ['SCHEMA DRIFT', '수신된 키: hook_event_name, source'], ['세션 중 변경됨'])
})
test('CC10 non-string source reports drift', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":123}'),
    ['SCHEMA DRIFT', '문자열이 아니어서'], ['세션 중 변경됨', '123 세션'])
})
// 11. payload keys and the event name match case-insensitively:
//     a lowercase event name and case-drifted keys still produce the banner.
test('CC11 case-drifted keys and a lowercase event name still audit', () => {
  assertSystemMessage(invokeHook('{"Hook_Event_Name":"configchange","SOURCE":"user_settings","File_Path":"/x/y"}'),
    [String.raw`\[hook:config-audit\] user_settings 세션 중 변경됨 \(/x/y\)`], ['SCHEMA DRIFT'])
})
// 12. file_path goes through the PowerShell [string] cast: a number renders as its digits, true as True, and an
//     array as its elements joined by a space, never "undefined", "null" or a JSON dump. A null is absent.
test('CC12 numeric file_path renders as its digits', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"user_settings","file_path":42}'),
    [String.raw`user_settings 세션 중 변경됨 \(42\) \(`], ['SCHEMA DRIFT', 'undefined'])
})
test('CC12 boolean file_path renders as True', () => {
  // (?-i): the match check reads patterns case-insensitively unless a pattern turns that off.
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"user_settings","file_path":true}'),
    [String.raw`(?-i)변경됨 \(True\) \(`], ['SCHEMA DRIFT', 'undefined'])
})
test('CC12 array file_path renders space-joined', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"user_settings","file_path":["a","b"]}'),
    [String.raw`변경됨 \(a b\) \(`], ['SCHEMA DRIFT', 'a,b'])
})
test('CC12 null file_path is no path', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"user_settings","file_path":null}'),
    [String.raw`user_settings 세션 중 변경됨 \(대부분`], ['SCHEMA DRIFT', 'null', String.raw`변경됨 \(\)`])
})
// 13. the drift banner's key list is payload text too: a key carrying a line break or U+2028 flattens,
//     and the list sorts case-insensitively.
test('CC13 a hostile key name in the drift banner flattens; keys sort case-insensitively', () => {
  assertSystemMessage(invokeHook(String.raw`{"hook_event_name":"ConfigChange","x\n[hook:forged]\u2028y":1,"Alpha":2,"beta":3}`),
    ['SCHEMA DRIFT', String.raw`수신된 키: Alpha, beta, hook_event_name, x \[hook:forged\] y\.`], [String.raw`[\r\n\u2028]`])
})
// 14. a payload string stays a string (spec 0006 §3.1): an ISO-date-shaped source is still a tier name.
test('CC14 a date-shaped source string is still a tier name', () => {
  assertSystemMessage(invokeHook('{"hook_event_name":"ConfigChange","source":"2026-01-02T03:04:05Z"}'),
    [String.raw`\] 2026-01-02T03:04:05Z 세션 중 변경됨`], ['SCHEMA DRIFT'])
})

// The hook owns no copy of inline(). It imports the one that every hook shares (hook-lib.selftest.mjs holds its behaviour).
// A local copy would split the character class.
test('CC15 inline() is imported from hook-lib.mjs and the hook defines no Inline/inline of its own', () => {
  const src = readFileSync(hook, 'utf8')
  const importsInline = /^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*'\.\/hook-lib\.mjs'/mu.test(src)
  const ownCopy = /\bfunction\s+inline\b|\b(?:const|let|var)\s+inline\b/iu.test(src)
  assert.ok(importsInline && !ownCopy, `imports inline from hook-lib: ${importsInline} · defines its own: ${ownCopy}`)
})

// R1. registration. Every case above pipes a payload straight into the script, so none of them sees
//     whether the runtime calls it, and the manifest gate checks only that a handler's path resolves,
//     not its event key or matcher. This pins the wiring (exec form, ADR 0116). A live probe shows that it fires.
test('R1 hooks.json registers this script once: ConfigChange, the four settings tiers (no skills), exec-form node <script>', () => {
  const fails = []
  try {
    const hj = JSON.parse(readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/config-change-audit\.(ps1|mjs)/iu.test(parts.join(' '))) sites.push({ ev, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/config-change-audit.mjs']
    const wantMatcher = 'user_settings|project_settings|local_settings|policy_settings'   // never `skills` (fires on every skill load)
    if (sites.length !== 1) fails.push(`want exactly 1 registration of config-change-audit (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.ev !== 'ConfigChange') fails.push(`event '${s.ev}' (want ConfigChange)`)
      if (s.matcher !== wantMatcher) fails.push(`matcher '${s.matcher}' (want '${wantMatcher}')`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') fails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) fails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//u, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) fails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
      if (String(s.h.timeout) !== '10') fails.push(`timeout '${s.h.timeout}' (want 10)`)
    }
  } catch (e) { fails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(fails, [], fails.join(' · '))
})

// META: every case above carries a negative, so the empty-mustNotMatch guard never fires here.
// Without this case, a deleted or broken guard turns nothing red.
const metaOut = { out: '{"systemMessage":"meta probe"}', exit: 0 }
test('CC16 META', () => {
  const f = systemMessageFailures(metaOut, ['meta probe'], [])
  assert.ok(f.length === 1 && /no mustNotMatch/iu.test(f[0]), `guard did not fire — reason='${f.join('; ')}'`)
})
test('CC17 META exemption honored', () => {
  const f = systemMessageFailures(metaOut, ['meta probe'], [], 'META: exercises the visible-exemption path so the escape hatch cannot rot unnoticed')
  assert.deepEqual(f, [], '-NoNegative exemption rejected')
})
