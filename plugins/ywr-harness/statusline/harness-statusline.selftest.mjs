// Selftest for harness-statusline.js.
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout statusline/harness-statusline.selftest.mjs
//
// The rendering rule that actually matters is the NEGATIVE one: a key the payload does not carry
// must make its segment vanish, never render as `0%`. Unmeasured and zero are different states, and
// the status line is the one surface where a confident wrong number is read hundreds of times a day
// without anyone re-checking it. Every absence case below exists for that.
//
// Payload fixtures are shaped from a live 2.1.220 payload, not from the docs.
//
// Patterns are regex sources matched case-insensitively (see toRx in lib/selftest-lib.mjs).
//
// Two ways of driving the subject. The stdin cases (A to G) start the script as a child, the way
// Claude Code does. The module cases (H, I, and the placement case) call the exported functions in this
// process. The three H cases that read CLAUDE_CONFIG_DIR still start a child, because a variable set in
// this process would leak into every later case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, assertMatch } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = path.join(here, 'harness-statusline.js')
const sl = createRequire(import.meta.url)(mod)

const fxBase = fixtureRoot('statusline-selftest')
process.on('exit', () => removeFixtureRoot(fxBase))

// A HOME with no plugin install registry, so the plugin-version segment cannot appear. Without
// this the suite reads the developer's real ~/.claude, and every exact-line assertion passes or
// fails depending on what that machine has installed.
const hermeticHome = path.join(fxBase, 'hermetic-home')
fs.mkdirSync(path.join(hermeticHome, '.claude'), { recursive: true })

// The child environment of the stdin cases. os.homedir() reads USERPROFILE on Windows and HOME elsewhere —
// both are pinned so the same fixture works on either platform. CLAUDE_CONFIG_DIR is CLEARED for the same
// hermetic reason: since ADR 0046 the renderer resolves it before ~/.claude, and a developer machine
// running under a config-dir account would otherwise leak its real registry into the exact-line
// assertions below.
function hermeticEnv() {
  const env = { ...process.env, USERPROFILE: hermeticHome, HOME: hermeticHome }
  delete env.CLAUDE_CONFIG_DIR
  return env
}

// stdout and stderr together, like `2>&1`.
const combined = (r) => r.stdout + r.stderr

// Each distinct payload runs once; a case that reads the same payload again reuses the result.
const runs = new Map()
function invokeRaw(json) {
  if (!runs.has(json)) runs.set(json, combined(runNode([mod], { env: hermeticEnv(), input: json })))
  return runs.get(json)
}
// Drive the module through stdin, exactly as Claude Code does. Output is stripped of ANSI so the
// assertions read as the text a person sees.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const invokeLine = (json) => stripAnsi(invokeRaw(json)).trim()

let n = 0
const st = (name, fn) => test(`ST${++n} ${name}`, fn)
const eq = (got, want) => assert.equal(got, want, `got: ${got}`)

const FULL = `{"model":{"display_name":"Opus 5 (1M context)","id":"claude-opus-5[1m]"},
 "effort":{"level":"xhigh"},
 "workspace":{"current_dir":"C:/Projects/ywrlabs/ywr-harness"},
 "context_window":{"used_percentage":24,"context_window_size":1000000},
 "rate_limits":{"five_hour":{"used_percentage":5},"seven_day":{"used_percentage":1}}}
`

// --- A: the whole line, and the model label losing its context parenthetical --------------------
const a = () => invokeLine(FULL)
st('A renders every segment', () => eq(a(), 'ywrlabs/ywr-harness · Opus 5 · xhigh · ctx 24%/1M · 5h 5% · 7d 1%'))
st('A the "(1M context)" suffix is gone', () => assertMatch(a(), { mustNotMatch: [String.raw`\(1M context\)`] }))
st('A the window size survives next to the percentage', () =>
  assertMatch(a(), { mustMatch: ['ctx 24%/1M'], noNegative: 'presence of one segment; the exact-line case above pins the rest' }))

// --- B: absent keys REMOVE their segment — never 0% --------------------------------------------
// The core honesty rule. Each of these is a payload state that genuinely occurs: rate_limits is
// missing on the first render of a session, before any API response.
const b = () => invokeLine('{"model":{"display_name":"Opus 5 (1M context)"},"effort":{"level":"xhigh"},"workspace":{"current_dir":"C:/a/b"}}')
st('B no context_window -> no ctx segment', () => assertMatch(b(), { mustNotMatch: ['ctx'] }))
st('B no rate_limits -> no 5h/7d segments', () => assertMatch(b(), { mustNotMatch: ['5h', '7d'] }))
st('B nothing is rendered as 0%', () => assertMatch(b(), { mustNotMatch: ['0%'] }))
st('B what IS known still renders', () => eq(b(), 'a/b · Opus 5 · xhigh'))

// --- C: a real 0 is NOT the same as absent, and must still print --------------------------------
// The control for B. If the absence rule were implemented as a falsiness check, a genuine 0% would
// disappear too — and the suite above would still be green.
const c = () => invokeLine('{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"used_percentage":0,"context_window_size":200000},"rate_limits":{"five_hour":{"used_percentage":0},"seven_day":{"used_percentage":0}}}')
st('C a measured 0 renders as 0%', () => assertMatch(c(), { mustMatch: ['ctx 0%/200k'], noNegative: 'the control for B: the zero must PRINT' }))
st('C measured 0 quota renders too', () => assertMatch(c(), { mustMatch: ['5h 0%', '7d 0%'], noNegative: 'the control for B: the zero must PRINT' }))

// --- D: size without a percentage must not leave a dangling "/1M" -------------------------------
st('D no percentage -> no dangling size', () =>
  assertMatch(invokeLine('{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"context_window_size":1000000}}'),
    { mustNotMatch: ['/1M'] }))

// --- E: only a CONTEXT parenthetical is stripped ------------------------------------------------
st('E a non-context parenthetical is preserved', () =>
  assertMatch(invokeLine('{"model":{"display_name":"Fable 5 (preview)"},"workspace":{"current_dir":"C:/a/b"},"context_window":{"used_percentage":40,"context_window_size":200000}}'),
    { mustMatch: [String.raw`Fable 5 \(preview\)`], noNegative: 'presence of the kept parenthetical' }))

// --- W: the worktree segment (ADR 0059) -----------------------------------------------------------
// workspace.git_worktree is a string (the linked-worktree name), as the docs and a captured payload
// show. The guard is still a type check: any other shape a host might send must vanish, never render
// as "[object Object]" next to the location.
const W = `{"model":{"display_name":"Opus 5 (1M context)","id":"claude-opus-5[1m]"},
 "effort":{"level":"xhigh"},
 "workspace":{"current_dir":"C:/Projects/ywrlabs/ywr-harness","git_worktree":"feature-xyz"},
 "context_window":{"used_percentage":24,"context_window_size":1000000},
 "rate_limits":{"five_hour":{"used_percentage":5},"seven_day":{"used_percentage":1}}}
`
st('W the worktree name renders right after the location', () =>
  eq(invokeLine(W), 'ywrlabs/ywr-harness · wt feature-xyz · Opus 5 · xhigh · ctx 24%/1M · 5h 5% · 7d 1%'))
st('W no git_worktree key -> no wt segment (main working tree)', () => assertMatch(invokeLine(FULL), { mustNotMatch: ['· wt '] }))
// A non-string shape — say the host ever switches to the worktree.* object form here — is
// UNMEASURED, not a value: the segment disappears rather than stringifying.
st('W a non-string git_worktree renders no segment', () =>
  assertMatch(invokeLine('{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b","git_worktree":{"name":"feature-xyz"}}}'),
    { mustNotMatch: ['wt', 'object'] }))
st('W a blank-string git_worktree renders no segment', () =>
  assertMatch(invokeLine('{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b","git_worktree":"  "}}'),
    { mustNotMatch: ['· wt'] }))
// Control bytes in the NAME are stripped, not rendered: a raw ESC would
// start an ANSI sequence of the member's choosing mid-line, and a newline would break the one
// line this renderer owns. Asserted on the RAW output — the ANSI-stripping invokeLine would
// mask an injected ESC that survived. The JSON text below carries the escapes as backslash
// sequences, so the renderer's parser makes the ESC and the newline.
const w5raw = () => invokeRaw(String.raw`{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"C:/a/b","git_worktree":"evil\u001b[31mred\nx"}}`)
st('W an injected ESC byte does not survive into the raw output', () =>
  assertMatch(w5raw(), { mustNotMatch: [String.raw`evil\x1b`] }))
st('W an injected newline does not split the line', () => {
  const trimmed = w5raw().trim()
  assert.ok(!trimmed.includes('\n'), `raw: ${w5raw()}`)
})
st('W the printable remainder still renders as the name', () =>
  assertMatch(w5raw(), { mustMatch: ['wt'], noNegative: 'the control for the two strip cases above: the name still prints' }))

// --- F: thresholds colour by band ----------------------------------------------------------------
// Asserted on the raw ANSI, because the colour IS the signal here — a wrong band is invisible in
// stripped text and this is the only place the two differ.
const lowCtx = () => invokeRaw('{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"context_window":{"used_percentage":50}}')
const hiCtx = () => invokeRaw('{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"context_window":{"used_percentage":95}}')
st('F context 50% is still green (ordinary working state)', () =>
  assertMatch(lowCtx(), { mustMatch: [String.raw`\x1b\[32m50%`], noNegative: 'one band probe; the edge cases below pin the neighbours' }))
st('F context 95% is red', () =>
  assertMatch(hiCtx(), { mustMatch: [String.raw`\x1b\[31m95%`], noNegative: 'one band probe; the edge cases below pin the neighbours' }))
// Quota uses the tighter band — 50% there is already "watch". Proves the two curves are distinct
// rather than one shared threshold.
st('F quota 50% is yellow — a different curve from context', () =>
  assertMatch(invokeRaw('{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},"rate_limits":{"five_hour":{"used_percentage":50}}}'),
    { mustMatch: [String.raw`\x1b\[33m50%`], noNegative: 'one band probe; the edge cases below pin the neighbours' }))
// Band EDGES, both sides of every threshold (context 70/90, quota 50/80, the weekly on the quota
// curve): a threshold moved by one point flips exactly one of these, where the interior probes
// above stay green. Integer inputs, so the renderer's Math.round leaves them as written.
const bandName = { 32: 'green', 33: 'yellow', 31: 'red' }
const metricOf = {
  context: (v) => `"context_window":{"used_percentage":${v}}`,
  '5h': (v) => `"rate_limits":{"five_hour":{"used_percentage":${v}}}`,
  '7d': (v) => `"rate_limits":{"seven_day":{"used_percentage":${v}}}`,
}
for (const [kind, v, code] of [['context', 69, 32], ['context', 70, 33], ['context', 89, 33], ['context', 90, 31],
  ['5h', 49, 32], ['5h', 79, 33], ['5h', 80, 31], ['7d', 49, 32], ['7d', 50, 33],
  ['7d', 79, 33], ['7d', 80, 31]]) {
  st(`F ${kind} ${v}% is ${bandName[code]} (band edge)`, () => {
    const edge = invokeRaw(`{"model":{"display_name":"m"},"workspace":{"current_dir":"a"},${metricOf[kind](v)}}`)
    assertMatch(edge, { mustMatch: [String.raw`\x1b\[${code}m${v}%`], noNegative: 'one edge probe per case; the other edges are separate cases' })
  })
}

// --- G: garbage in must not throw ----------------------------------------------------------------
// A status line that crashes takes the status line away on every render.
st('G unparseable stdin still renders something', () =>
  assertMatch(invokeLine('not json at all'), { mustMatch: [String.raw`\?`], noNegative: 'the fallback location is the one thing to see' }))
st('G empty stdin does not crash', () => {
  const r = runNode([mod], { env: hermeticEnv(), input: '' })
  assert.equal(r.error, undefined, `spawn error: ${r.error}`)
  assert.equal(r.status, 0, `exit ${r.status}: ${combined(r)}`)
})

// --- H: the installed-plugin-version segment ------------------------------------------------------
// Read from Claude Code's install registry — the ON-DISK value. With marketplace auto-update on,
// disk moves ahead of a live session; that mismatch is the "restart to apply" signal, so the
// segment must show what this machine HAS, never what a repo or the marketplace published.
//
// pluginVersion takes the CONFIG DIR itself (explicit arg -> CLAUDE_CONFIG_DIR -> ~/.claude), not a
// home to append `.claude` to (ADR 0046). The fixtures keep their home shape and the append happens
// here. The explicit arg also short-circuits the env var, which keeps these cases hermetic on a
// machine running under a config-dir account.
const invokeVer = (homeDir) => sl.pluginVersion(path.join(homeDir, '.claude')) || '<empty>'
function newHome(name, json) {
  const h = path.join(fxBase, name)
  fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true })
  if (json !== null) fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), json)
  return h
}

const h1 = newHome('installed', '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"user","version":"0.14.0"}]}}')
st('H the installed version is extracted, v-prefixed', () => eq(invokeVer(h1), 'v0.14.0'))

st('H no registry -> empty, segment disappears', () => eq(invokeVer(newHome('no-registry', null)), '<empty>'))

st('H an unparseable registry does not crash the line', () => eq(invokeVer(newHome('garbage', '{ not json')), '<empty>'))

st('H a machine without the plugin yields nothing', () =>
  eq(invokeVer(newHome('not-installed', '{"version":2,"plugins":{"other-plugin@somewhere":[{"version":"1.0.0"}]}}')), '<empty>'))

// "unknown" is a real registry state of an official-marketplace plugin: it is not a version and
// must not render as one.
st('H an "unknown" version renders no segment', () =>
  eq(invokeVer(newHome('unknown-version', '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"version":"unknown"}]}}')), '<empty>'))

// Only the plugin name is pinned. A consuming org may register the marketplace under another
// name, and the segment must survive that.
st('H the marketplace half of the key is not hardcoded', () =>
  eq(invokeVer(newHome('other-marketplace', '{"version":2,"plugins":{"ywr-harness@client-mkt":[{"version":"0.15.0"}]}}')), 'v0.15.0'))

// Entries are not guaranteed array-wrapped. The [].concat defense must be pinned, or a future
// refactor to a plain array assumption passes green today and crashes live on a bare object.
st('H a bare-object (non-array) entry still works', () =>
  eq(invokeVer(newHome('bare-object-entry', '{"version":2,"plugins":{"ywr-harness@ywrlabs":{"scope":"user","version":"0.9.9"}}}')), 'v0.9.9'))

// Scope shadow: a stale project-scope entry listed FIRST must not shadow the user-scope install.
// The statusline is placed machine-wide, so user scope wins, then recency — never registry order.
st('H user scope wins over an earlier project-scope entry', () =>
  eq(invokeVer(newHome('scope-shadow', '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"project","version":"0.10.0","lastUpdated":"2026-07-01T00:00:00.000Z"},{"scope":"user","version":"0.14.0","lastUpdated":"2026-07-29T00:00:00.000Z"}]}}')), 'v0.14.0'))

// A "version" with no digit — "v", whitespace: corrupted-write shapes — must not render as one.
st('H a digit-less version renders no segment', () =>
  eq(invokeVer(newHome('digitless-version', '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"version":"v"}]}}')), '<empty>'))

// The next three cases need the environment variable or the working directory of the process that
// calls pluginVersion, so each starts a child with them set and nothing leaks into this process.
function versionChild(env, cwd) {
  const code = `process.stdout.write(require(${JSON.stringify(mod.replace(/\\/g, '/'))}).pluginVersion() || '<empty>')`
  return combined(runNode(['-e', code], { env, cwd })).trim()
}

// No-arg resolution follows CLAUDE_CONFIG_DIR before ~/.claude (ADR 0046): a multi-account
// machine must see the RUNNING account's install, never another account's.
const h10 = newHome('config-dir-account', '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"user","version":"0.30.0"}]}}')
st('H no-arg resolution follows CLAUDE_CONFIG_DIR', () =>
  eq(versionChild({ ...process.env, CLAUDE_CONFIG_DIR: path.join(h10, '.claude') }), 'v0.30.0'))

// An explicit arg beats the env var — every hermetic case above depends on exactly this.
st('H an explicit dir beats CLAUDE_CONFIG_DIR', () => {
  const code = `process.stdout.write(require(${JSON.stringify(mod.replace(/\\/g, '/'))}).pluginVersion(${JSON.stringify(path.join(h1, '.claude'))}) || '<empty>')`
  const got = combined(runNode(['-e', code], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(h10, '.claude') } })).trim()
  eq(got, 'v0.14.0')
})

// A set-but-RELATIVE CLAUDE_CONFIG_DIR reads as UNMEASURED (no segment), never as a cwd-relative
// path: a registry planted at exactly the cwd-relative spot must stay
// invisible — a cwd-dependent read would make the segment flicker with wherever the renderer
// happened to be spawned.
const h12 = path.join(fxBase, 'cwd-trap')
fs.mkdirSync(path.join(h12, 'rel-cfg', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(h12, 'rel-cfg', 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{"ywr-harness@ywrlabs":[{"scope":"user","version":"9.9.9"}]}}')
st('H a relative CLAUDE_CONFIG_DIR is unmeasured — the cwd-planted registry stays invisible', () =>
  eq(versionChild({ ...process.env, CLAUDE_CONFIG_DIR: 'rel-cfg' }, h12), '<empty>'))

// Placement, asserted by INJECTING the value rather than reading the machine's real cache. A suite
// whose verdict depends on the developer's ~/.claude is not a suite.
const invokeRender = (json, guide) => stripAnsi(sl.render(JSON.parse(json), guide).line).trim()
st('H the segment renders last, after the quota segments', () =>
  assertMatch(invokeRender(FULL, 'v0.14.0'), { mustMatch: [String.raw`7d 1% · ywr-harness v0\.14\.0$`], noNegative: 'the position is the claim; absence is the next case' }))
// The location segment of FULL also contains the string "ywr-harness", so the absence assertion
// targets the label-plus-version form, not the bare name.
st('H an empty version renders no segment at all', () => assertMatch(invokeRender(FULL, ''), { mustNotMatch: ['ywr-harness v'] }))

// --- J: a Fable session renders like every other model — weekly at the TAIL, never inline --------
// An inline `Fable 5(7d N%)` would read as a Fable-scoped figure, which /usage shows on a different
// denominator (the Team-plan Fable cap), while the payload carries only the account-wide weekly
// (five_hour and seven_day, no model-scoped key). ADR 0049 removed the inline form that ADR 0047 added;
// these cases pin the removal so the parenthetical cannot quietly return.
const FABLE = `{"model":{"display_name":"Fable 5 (1M context)","id":"claude-fable-5[1m]"},
 "effort":{"level":"xhigh"},
 "workspace":{"current_dir":"C:/Projects/ywrlabs/ywr-harness"},
 "context_window":{"used_percentage":24,"context_window_size":1000000},
 "rate_limits":{"five_hour":{"used_percentage":5},"seven_day":{"used_percentage":3}}}
`
const j1 = () => invokeLine(FABLE)
st('J a Fable session is shaped exactly like the Opus line — tail 7d, no parenthetical', () =>
  eq(j1(), 'ywrlabs/ywr-harness · Fable 5 · xhigh · ctx 24%/1M · 5h 5% · 7d 3%'))
st('J no inline weekly parenthetical anywhere on a Fable session', () => assertMatch(j1(), { mustNotMatch: [String.raw`\(7d `] }))

// The absence rule is model-independent: no rate_limits -> no weekly anywhere.
st('J unmeasured weekly -> plain label, no weekly anywhere', () =>
  eq(invokeLine('{"model":{"display_name":"Fable 5","id":"claude-fable-5"},"workspace":{"current_dir":"C:/a/b"}}'), 'a/b · Fable 5'))

// A measured 0 is a value, not an absence — and it renders at the TAIL, id-detected model or not.
st('J a measured 0 renders at the tail as 7d 0%', () =>
  eq(invokeLine('{"model":{"display_name":"Fable 5","id":"claude-fable-5"},"workspace":{"current_dir":"C:/a/b"},"rate_limits":{"seven_day":{"used_percentage":0}}}'), 'a/b · Fable 5 · 7d 0%'))

// --- I: the tab-title head is the ACCOUNT, falling back to location (ADR 0046) -------------------
// The account (config-dir basename, leading dot stripped) is the one session dimension with no
// other surface — `loc` is already the line's first segment. Env is passed as a plain object, so
// no real environment is consulted or mutated.
const invokeTitle = (json, envMap) => sl.tabTitle(sl.render(JSON.parse(json), ''), envMap)
st('I a config-dir account heads the title', () => eq(invokeTitle(FULL, { CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude-ywrlabs' }), 'claude-ywrlabs/Opus 5/xhigh'))
st('I no CLAUDE_CONFIG_DIR -> the location heads the title, unchanged', () => eq(invokeTitle(FULL, {}), 'ywrlabs/ywr-harness/Opus 5/xhigh'))
st('I a trailing separator and forward slashes still yield the account', () => eq(invokeTitle(FULL, { CLAUDE_CONFIG_DIR: '/home/x/.claude-orcait/' }), 'claude-orcait/Opus 5/xhigh'))
// Degenerate shapes that strip to NOTHING must fall back to the location — never a bare "/model"
// title. This pins tabTitle's `|| r.loc` fallback, which a `??` "modernization" would silently break
// for exactly these values.
st('I a basename that strips to nothing falls back to the location', () => eq(invokeTitle(FULL, { CLAUDE_CONFIG_DIR: '/home/x/.' }), 'ywrlabs/ywr-harness/Opus 5/xhigh'))
st('I a whitespace-only value falls back to the location', () => eq(invokeTitle(FULL, { CLAUDE_CONFIG_DIR: '   ' }), 'ywrlabs/ywr-harness/Opus 5/xhigh'))
