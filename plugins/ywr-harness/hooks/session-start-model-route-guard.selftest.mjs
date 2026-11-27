// Self-test for session-start-model-route-guard.mjs (ADR 0107, ADR 0116).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/session-start-model-route-guard.selftest.mjs
//
// Hermetic by construction (fact 16): every child runs with the guarded variables CLEARED and
// CLAUDE_CONFIG_DIR / CLAUDE_PROJECT_DIR / USERPROFILE / HOME pointed into the fixture, then gets
// only the case's own values — the owner's real settings.json and a CI runner's environment never
// reach a verdict. Payload shape: the SessionStart contract of the raw hooks doc (read 2026-09-29:
// `source`, optional `model`); the hook needs only `hook_event_name` (and `cwd` as a project-dir
// fallback), so the cases send the documented fields and nothing invented.
// Every match-based case carries MustNotMatch as well as MustMatch (the empty-MustNotMatch class).
//
// The pwsh suite changed the process environment around each child and restored it afterwards. Here the
// child gets its own environment object, so the suite process never changes. The case names are the old
// names, and the parity check of ADR 0227 decision 8 reads them. The one old name without an ID, META,
// is `META1 <the old name>`. Patterns are pwsh -match sources (case-insensitive; see toRx in
// lib/selftest-lib.mjs).
//
// Special characters in patterns and values are built from code points: the class under test includes
// U+0085, U+2028 and U+2029, and escape text for those can materialize as the literal character through
// an editor, so no such character, and no escape for one, appears in this source.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, matchFailures } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'session-start-model-route-guard.mjs')
const B = '`'
const ch = (...c) => String.fromCharCode(...c)
const rxEscape = s => s.replace(/[\\*+?|{[()^$.#]/g, '\\$&')

const guarded = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_EFFORT_LEVEL']
const pinned = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'USERPROFILE', 'HOME']
const cleared = new Set([...guarded, ...pinned].map(k => k.toUpperCase()))

const fx = fixtureRoot('ssmrg-selftest')
after(() => removeFixtureRoot(fx))

const userDir = path.join(fx, 'config'), proj = path.join(fx, 'proj'), homeDir = path.join(fx, 'home')
for (const d of [userDir, path.join(proj, '.claude'), path.join(homeDir, '.claude')]) fs.mkdirSync(d, { recursive: true })
function setJson(p, text) {
  if (text) fs.writeFileSync(p, text)
  else if (fs.existsSync(p)) fs.rmSync(p)
}

// Env: the case's variables. User / Project / Local / HomeUser: settings file text ('' = absent).
// noConfigDir leaves CLAUDE_CONFIG_DIR unset so the home fallback is read; noProjectDir leaves
// CLAUDE_PROJECT_DIR unset so the payload cwd is the project.
// An empty stdin means the default payload and is tested for emptiness (a null test sent an empty payload
// and left every speaking case silent — caught by META).
// Returns the output of stdout and stderr together, as `2>&1` read them, and the exit code.
function invokeGuard({ env = {}, user = '', project = '', local = '', homeUser = '', stdin = '', preflight = false, noConfigDir = false, noProjectDir = false } = {}) {
  setJson(path.join(userDir, 'settings.json'), user)
  setJson(path.join(proj, '.claude/settings.json'), project)
  setJson(path.join(proj, '.claude/settings.local.json'), local)
  setJson(path.join(homeDir, '.claude/settings.json'), homeUser)
  // The names clear case-insensitively, as Windows reads them.
  const childEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!cleared.has(k.toUpperCase())) childEnv[k] = v
  if (!noConfigDir) childEnv.CLAUDE_CONFIG_DIR = userDir
  if (!noProjectDir) childEnv.CLAUDE_PROJECT_DIR = proj
  childEnv.USERPROFILE = homeDir
  childEnv.HOME = homeDir
  Object.assign(childEnv, env)
  let input
  let args = [hook]
  if (preflight) args = [hook, '--preflight']
  else {
    if (!stdin) stdin = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'selftest', source: 'startup', cwd: proj })
    input = Buffer.from(stdin + '\n', 'utf8')
  }
  const r = spawnSync(process.execPath, args, { input, env: childEnv, windowsHide: true })
  return { out: (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? ''), exit: r.status }
}

const oneLineRx = new RegExp(`[\\r\\n${ch(0x85, 0x2028, 0x2029)}]`)
function warnFailures({ out, exit }, mustMatch, mustNotMatch) {
  const pre = []
  if (exit !== 0) pre.push(`exit ${exit} (want 0 — SessionStart blocks nothing)`)
  let sys = ''
  try {
    const j = JSON.parse(out.trim())
    sys = typeof j.systemMessage === 'string' ? j.systemMessage : ''
    if (j.hookSpecificOutput !== undefined && j.hookSpecificOutput !== null) pre.push('hookSpecificOutput present — the guard speaks to the member only, never into the model context')
  } catch { pre.push('stdout is not valid JSON') }
  if (!sys) pre.push('no systemMessage')
  if (oneLineRx.test(sys)) pre.push('systemMessage is not one line')
  if (/\bADR\s*\d/i.test(sys)) pre.push('systemMessage cites a decision number (spec 0006 §3.1)')
  return matchFailures(sys, { mustMatch, mustNotMatch, preFail: pre, label: 'systemMessage' })
}
function silentFailures({ out, exit }) {
  const fails = []
  if (exit !== 0) fails.push(`exit ${exit} (want 0)`)
  if (out.trim()) fails.push(`expected byte-silent stdout (it would become session context), got: ${out.trim()}`)
  return fails
}
function preflightFailures({ out, exit }, want, mustMatch, mustNotMatch) {
  const pre = []
  if (exit !== want) pre.push(`exit ${exit} (want ${want})`)
  return matchFailures(out, { mustMatch, mustNotMatch, preFail: pre })
}
const detail = (f, r) => `${f.join(' · ')}\n--- output ---\n${r.out}`
function assertWarn(r, mustMatch, mustNotMatch) { const f = warnFailures(r, mustMatch, mustNotMatch); assert.deepEqual(f, [], detail(f, r)) }
function assertSilent(r) { const f = silentFailures(r); assert.deepEqual(f, [], detail(f, r)) }
function assertPreflight(r, want, mustMatch, mustNotMatch) { const f = preflightFailures(r, want, mustMatch, mustNotMatch); assert.deepEqual(f, [], detail(f, r)) }

const core = ['^\\[hook:model-route\\]', 'family alias', '지우세요', '막지 않았습니다']

// --- preflight (the eval runner's refusal) ---------------------------------------------------
test('P1 a clean shell is clear, exit 0', () => {
  assertPreflight(invokeGuard({ preflight: true }), 0, ['^preflight: clear'], ['REFUSED'])
})
for (const c of [
  { n: 'P2 a family override refuses, whatever its value', e: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus' }, m: 'ANTHROPIC_DEFAULT_OPUS_MODEL=opus' },
  { n: 'P3 a full-id session model refuses', e: { ANTHROPIC_MODEL: 'claude-opus-4-6' }, m: 'ANTHROPIC_MODEL=claude-opus-4-6' },
  { n: 'P4 a full-id subagent model refuses', e: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5' }, m: 'CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5' },
  { n: 'P4b an ALIAS subagent model refuses too (it moves every unassigned worker to that family)', e: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, m: 'CLAUDE_CODE_SUBAGENT_MODEL=haiku' },
  { n: 'P4c an ALIAS workflow model refuses (it moves every workflow agent, the per-call model included)', e: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'sonnet' }, m: 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=sonnet' },
  { n: 'P4d a full-id workflow model refuses', e: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'claude-sonnet-5' }, m: 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=claude-sonnet-5' },
  { n: 'P5 a cloud provider refuses', e: { CLAUDE_CODE_USE_BEDROCK: '1' }, m: 'CLAUDE_CODE_USE_BEDROCK \\(this shell\\)' },
  { n: 'P6 ANTHROPIC_DEFAULT_MODEL with a full id refuses', e: { ANTHROPIC_DEFAULT_MODEL: 'claude-haiku-4-5' }, m: 'ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5' },
]) {
  test(c.n, () => {
    assertPreflight(invokeGuard({ preflight: true, env: c.e }), 1, [`preflight: REFUSED — ${c.m}`, 'unset the variable'], ['preflight: clear'])
  })
}
test('P7 aliases and off values are clear (sonnet[1m], opusplan, provider 0/false)', () => {
  assertPreflight(invokeGuard({ preflight: true, env: { ANTHROPIC_MODEL: 'sonnet[1m]', ANTHROPIC_DEFAULT_MODEL: 'opusplan', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: 'false' } }),
    0, ['^preflight: clear'], ['REFUSED'])
})
test('P8 preflight ignores settings files (an eval child gets its own config dir)', () => {
  assertPreflight(invokeGuard({ preflight: true, user: '{"model":"claude-opus-4-6","modelOverrides":{"claude-opus-5-5":"x"}}' }),
    0, ['^preflight: clear'], ['REFUSED'])
})
test('P9 preflight ignores CLAUDE_CODE_EFFORT_LEVEL (the eval wrapper sets it to low itself, ADR 0103/0130)', () => {
  assertPreflight(invokeGuard({ preflight: true, env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' } }), 0, ['^preflight: clear'], ['REFUSED', 'EFFORT'])
})
test('P10 an empty or blank workflow model is clear', () => {
  assertPreflight(invokeGuard({ preflight: true, env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '  ' } }), 0, ['^preflight: clear'], ['REFUSED', 'WORKFLOW'])
})
test('P11 the subagent and the workflow model together refuse with both lines', () => {
  assertPreflight(invokeGuard({ preflight: true, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'opus' } }),
    1, ['preflight: REFUSED — CLAUDE_CODE_SUBAGENT_MODEL=haiku', 'preflight: REFUSED — CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=opus'], ['preflight: clear'])
})

// --- the SessionStart guard --------------------------------------------------------------------
test('S1 nothing set -> byte-silent', () => { assertSilent(invokeGuard()) })
test('S2 alias-only settings (model: opus[1m], empty modelOverrides, alias env) -> byte-silent', () => {
  assertSilent(invokeGuard({ user: '{"model":"opus[1m]","modelOverrides":{},"env":{"ANTHROPIC_DEFAULT_MODEL":"haiku"}}', env: { ANTHROPIC_MODEL: 'Opus' } }))
})
test('S3 a wrong event is silent', () => {
  assertSilent(invokeGuard({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' }, stdin: '{"hook_event_name":"PreToolUse"}' }))
})
test('S4 unparseable stdin is silent (fail-open)', () => {
  assertSilent(invokeGuard({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' }, stdin: 'not json' }))
})
test('S5 an unparseable settings file is skipped, not reported', () => {
  assertSilent(invokeGuard({ user: '{"model": "claude-opus-4-6",', project: 'nope' }))
})

test('W1 a family override in the environment warns, naming key, value and alias', () => {
  assertWarn(invokeGuard({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5' } }),
    [...core, `${B}ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5${B} \\(환경변수\\)`, `${B}sonnet${B} alias`], ['ANTHROPIC_MODEL', 'modelOverrides'])
})
test('W2 every env kind in one message (session id, subagent id, provider)', () => {
  assertWarn(invokeGuard({ env: { ANTHROPIC_MODEL: 'claude-opus-4-6', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5', CLAUDE_CODE_USE_FOUNDRY: '1' } }),
    [...core, 'ANTHROPIC_MODEL=claude-opus-4-6', 'CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5', 'CLAUDE_CODE_USE_FOUNDRY', 'provider'], ['ANTHROPIC_DEFAULT_'])
})
test('W3 a full-id model in the user settings warns with the file', () => {
  assertWarn(invokeGuard({ user: '{"model":"claude-sonnet-5"}' }),
    [...core, `${B}model: claude-sonnet-5${B}`, rxEscape(path.join(userDir, 'settings.json'))], ['modelOverrides', '환경변수'])
})
test('W4 a non-empty modelOverrides in the project settings warns with its count', () => {
  assertWarn(invokeGuard({ project: '{"modelOverrides":{"claude-opus-5-5":"arn:x","claude-sonnet-5-5":"arn:y"}}' }),
    [...core, `${B}modelOverrides${B} 2개 항목`, rxEscape(path.join(proj, '.claude/settings.json'))], [`${B}model:`, '환경변수'])
})
test('W4b a hand-edited settings file (// and block comments, a trailing comma) is still read: its full-id model warns (ConvertFrom-Json read these)', () => {
  assertWarn(invokeGuard({ user: `{\n  // pinned for the migration\n  "model": "claude-opus-4-6", /* old route */\n  "env": { "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5", },\n}` }),
    [...core, `${B}model: claude-opus-4-6${B}`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5${B} \\(.*settings\\.json env\\)`], ['환경변수'])
})
test('W5 a settings env key is reported from the local file; the same key in the process env is reported once', () => {
  assertWarn(invokeGuard({ local: '{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-haiku-4-5","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-4-6"}}', env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' } }),
    [...core, `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5${B} \\(환경변수\\)`, `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6${B} \\(.*settings\\.local\\.json env\\)`],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL[^;]*settings\\.local\\.json'])
})
test('W6 without CLAUDE_CONFIG_DIR the home settings file is read', () => {
  assertWarn(invokeGuard({ noConfigDir: true, homeUser: '{"model":"claude-opus-4-6"}', user: '{"model":"claude-haiku-4-5"}' }),
    [...core, `${B}model: claude-opus-4-6${B}`, rxEscape(path.join(homeDir, '.claude'))], ['claude-haiku-4-5'])
})
test('W7 without CLAUDE_PROJECT_DIR the payload cwd names the project', () => {
  assertWarn(invokeGuard({ noProjectDir: true, project: '{"model":"claude-sonnet-5"}' }),
    [...core, `${B}model: claude-sonnet-5${B}`, rxEscape(path.join(proj, '.claude'))], ['환경변수'])
})
const other = path.join(fx, 'other')
fs.mkdirSync(path.join(other, '.claude'), { recursive: true })
fs.writeFileSync(path.join(other, '.claude/settings.json'), '{"model":"claude-haiku-4-5"}')
test('W9 CLAUDE_PROJECT_DIR wins over the payload cwd (a subdirectory session still reads the project)', () => {
  assertWarn(invokeGuard({ project: '{"model":"claude-sonnet-5"}', stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: other }) }),
    [...core, `${B}model: claude-sonnet-5${B}`], ['claude-haiku-4-5'])
})
// --- the workflow model (ADR 0132) ---------------------------------------------------------------
const wfCore = [...core, '모든 워크플로 에이전트가 이 모델로', '호출이 지정한 모델보다 우선']
test('WF1 an ALIAS workflow model in the environment warns in the model clause', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'sonnet' } }),
    [...wfCore, `${B}CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=sonnet${B} \\(환경변수\\)`], ['effort pin', 'CLAUDE_CODE_SUBAGENT_MODEL='])
})
test('WF2 a full-id workflow model in the environment warns', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'claude-sonnet-5' } }),
    [...wfCore, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=claude-sonnet-5${B} \\(환경변수\\)`], ['effort pin'])
})
test('WF3 a workflow model set only in a settings env block is read, with its file', () => {
  assertWarn(invokeGuard({ project: '{"env":{"CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL":"haiku"}}' }),
    [...wfCore, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=haiku${B} \\(.*settings\\.json env\\)`], ['환경변수', 'effort pin'])
})
test('WF4 the same workflow key in the process env and a settings env block is reported once, from the environment', () => {
  assertWarn(invokeGuard({ local: '{"env":{"CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL":"opus"}}', env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'haiku' } }),
    [...wfCore, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=haiku${B} \\(환경변수\\)`], ['CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=opus', 'settings\\.local\\.json'])
})
test('WF5 an empty or blank workflow model is silent', () => {
  assertSilent(invokeGuard({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '  ' }, user: '{"env":{"CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL":""}}' }))
})
test('WF6 the subagent and the workflow model together warn with both findings', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'opus' } }),
    [...wfCore, `${B}CLAUDE_CODE_SUBAGENT_MODEL=haiku${B} \\(환경변수\\)`, `${B}CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=opus${B} \\(환경변수\\)`], ['effort pin'])
})

// --- the effort pin (ADR 0130) -------------------------------------------------------------------
const effCore = ['^\\[hook:model-route\\]', 'effort pin 을 덮어쓰는', 'ywr-harness 규칙: 워커 effort 는 역할별', '지우세요', '막지 않았습니다']
test('E1 CLAUDE_CODE_EFFORT_LEVEL in the environment warns alone, with no model clause', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }),
    [...effCore, `${B}CLAUDE_CODE_EFFORT_LEVEL=high${B} \\(환경변수\\)`, `호출별 ${B}effort${B} 보다 우선`], ['family alias', '최신이 아닌 모델'])
})
test('E2 a settings env effort is reported with its file; the same key in the process env is reported once', () => {
  assertWarn(invokeGuard({ local: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}', env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }),
    [...effCore, `CLAUDE_CODE_EFFORT_LEVEL=low${B} \\(환경변수\\)`], ['CLAUDE_CODE_EFFORT_LEVEL=max', 'family alias'])
})
test('E3 an effort set only in a settings env block is read', () => {
  assertWarn(invokeGuard({ user: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}' }),
    [...effCore, `CLAUDE_CODE_EFFORT_LEVEL=medium${B} \\(.*settings\\.json env\\)`], ['환경변수', 'family alias'])
})
test('E4 a model route and the effort pin share one message, model clause first', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5' } }),
    [...core, ...effCore, 'family alias.*effort pin 을 덮어쓰는', 'CLAUDE_CODE_EFFORT_LEVEL=xhigh', 'ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5'], ['effort pin 을 덮어쓰는.*family alias'])
})
test('E5 an empty or blank CLAUDE_CODE_EFFORT_LEVEL is silent', () => {
  assertSilent(invokeGuard({ env: { CLAUDE_CODE_EFFORT_LEVEL: '  ' }, project: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":""}}' }))
})
test('E6 the settings effortLevel key is not read (a frontmatter pin beats it)', () => {
  assertSilent(invokeGuard({ user: '{"effortLevel":"max"}' }))
})
test('E7 among settings files the highest-precedence one is named (local over project over user)', () => {
  assertWarn(invokeGuard({ user: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"low"}}', project: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}', local: '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}' }),
    [...effCore, `CLAUDE_CODE_EFFORT_LEVEL=max${B} \\(.*settings\\.local\\.json env\\)`], ['=low', '=medium', '환경변수'])
})
const forgedEffort = 'hi' + ch(0x2028) + '[hook:forged]' + B + 'x'.repeat(200)
test('E8 a crafted effort value renders on one line, with no backtick of its own, capped', () => {
  assertWarn(invokeGuard({ env: { CLAUDE_CODE_EFFORT_LEVEL: forgedEffort } }),
    [...effCore, `CLAUDE_CODE_EFFORT_LEVEL=hi \\[hook:forged\\] x+…${B} \\(환경변수\\)`], [`forged\\]${B}`, 'x{80}'])
})

const forged = 'claude-x' + ch(0x2028) + '[hook:forged] 차단됨' + B
test('W8 a crafted value renders on one line with no backtick of its own', () => {
  assertWarn(invokeGuard({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: forged } }),
    [...core, `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-x \\[hook:forged\\] 차단됨${B} \\(`], [`차단됨${B}${B}`])
})

// The flattening class is hook-lib.mjs's inline() (spec 0006 §3.1), and hook-lib.selftest.mjs owns its
// behaviour. This hook must USE it and carry no copy of its own: a second implementation is how a
// fix to one leaves the other forgeable. The behavioural flattening cases are W8 above, W3/W4 and the
// newline/quote ones below, which run the real hook.
test('I1 the hook imports inline() from hook-lib.mjs and defines no copy of its own', () => {
  const hookText = fs.readFileSync(hook, 'utf8')
  const importsInline = /^import\s*\{[^}]*\binline\b[^}]*\}\s*from\s*'\.\/hook-lib\.mjs'\s*$/im.test(hookText)
  const ownCopy = /^\s*(export\s+)?(function\s+inline\b|(const|let|var)\s+inline\s*=)/im.test(hookText)
  assert.ok(importsInline && !ownCopy, `imports hook-lib inline: ${importsInline} · own copy present: ${ownCopy}`)
})

// --- registration ------------------------------------------------------------------------------
test('R1 registered once under SessionStart with matcher startup|resume|fork, exec-form node <script> (clear/compact keep the process env)', () => {
  const regFails = []
  try {
    const hk = JSON.parse(fs.readFileSync(path.join(here, 'hooks.json'), 'utf8'))
    const sites = []
    for (const [ev, groups] of Object.entries(hk.hooks ?? {})) {
      for (const grp of [groups].flat().filter(Boolean)) {
        for (const h of [grp.hooks].flat().filter(Boolean)) {
          const parts = [String(h.command ?? ''), ...[h.args ?? []].flat().map(String)]
          if (/session-start-model-route-guard\.(ps1|mjs)/i.test(parts.join(' '))) sites.push({ event: ev, matcher: String(grp.matcher ?? ''), h })
        }
      }
    }
    const wantArgs = ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-model-route-guard.mjs']
    if (sites.length !== 1) regFails.push(`want exactly 1 registration of session-start-model-route-guard (.mjs or the retired .ps1), found ${sites.length}`)
    else {
      const s = sites[0]
      const gotArgs = [s.h.args ?? []].flat().map(String)
      if (s.event !== 'SessionStart') regFails.push(`event '${s.event}' (want SessionStart)`)
      if (s.matcher !== 'startup|resume|fork') regFails.push(`matcher '${s.matcher}' (want exactly 'startup|resume|fork' — clear/compact keep the process env)`)
      if (String(s.h.type) !== 'command' || String(s.h.command) !== 'node') regFails.push(`handler type/command '${s.h.type}'/'${s.h.command}' (want command/node)`)
      if (gotArgs.join('\0') !== wantArgs.join('\0')) regFails.push(`args [${gotArgs.join(' ')}] (want exec form [${wantArgs.join(' ')}])`)
      else {
        const resolved = path.join(path.dirname(here), gotArgs.at(-1).replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ''))
        if (path.resolve(resolved) !== path.resolve(hook)) regFails.push(`args resolve to '${resolved}', not this suite's script '${hook}'`)
      }
    }
  } catch (e) { regFails.push(`hooks.json unreadable: ${e.message}`) }
  assert.deepEqual(regFails, [], regFails.join(' · '))
})

// META — the silent assertion must refuse a speaking run, or S1–S5 prove nothing.
test('META1 META Assert-Silent refuses a speaking run', () => {
  const metaOut = invokeGuard({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' } })
  assert.ok(silentFailures(metaOut).length > 0, 'assertSilent accepted a speaking run')
})
