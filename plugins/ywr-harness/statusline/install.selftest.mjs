// Selftest for install.mjs. It writes into the user's global settings.json, so two cases matter
// most: an unrelated key survives the rewrite, and another tool's statusLine is never clobbered.
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout statusline/install.selftest.mjs
//
// --claude-dir points every case at a fixture, so the real ~/.claude is never involved.
//
// Test names read `SI<n> <text>`, and the parity check matches them (ADR 0227 decision 8).
// Patterns are case-insensitive regex sources (toRx in lib/selftest-lib.mjs).
//
// Some cases continue from the state that an earlier section left in the same fixture directory.
// Each such section names the earlier one through `lazy`, so a case never reads a state that no
// step made and the test order does not matter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, assertMatch, matchFailures } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const install = path.join(here, 'install.mjs')
const canonScript = path.join(here, 'harness-statusline.js')
const SCRIPT = 'harness-statusline.js'

const fxBase = fixtureRoot('statusline-install-selftest')
process.on('exit', () => removeFixtureRoot(fxBase))

// Stdout and stderr joined. `env` and `cwd` are for the cases that set CLAUDE_CONFIG_DIR.
function invokeInstall(dir, extra = [], opts = {}) {
  const r = runNode([install, '--claude-dir', dir, ...extra], opts)
  return { out: r.stdout + r.stderr, code: r.status }
}
function invokeNoFlag(opts) {
  const r = runNode([install], opts)
  return { out: r.stdout + r.stderr, code: r.status }
}
function newDir(name) {
  const p = path.join(fxBase, name)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const settingsPath = (dir) => path.join(dir, 'settings.json')
function getSettings(dir) {
  const p = settingsPath(dir)
  return fs.existsSync(p) && fs.statSync(p).isFile() ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const lazy = (fn) => { let done = false; let v; return () => { if (!done) { v = fn(); done = true } return v } }
const envWith = (name, value) => ({ ...process.env, [name]: value })

let n = 0
const si = (name, fn) => test(`SI${++n} ${name}`, fn)
// An absent key and a null value are the same state.
const assertAbsent = (v, label) => assert.ok(v === undefined || v === null, `${label}=${v}`)

// --- A: empty dir — script placed, statusLine written -------------------------------------------
const a = newDir('fresh')
const rA = lazy(() => invokeInstall(a))
si('A exits 0', () => assert.equal(rA().code, 0, `exit=${rA().code} out=${rA().out}`))
si('A script is placed', () => assert.ok((rA(), isFile(path.join(a, SCRIPT))), 'script missing'))
si('A placement is reported as created', () => assertMatch(rA().out, { mustMatch: [String.raw`harness-statusline\.js created`], noNegative: 'presence of the report line' }))
si('A statusLine is wired', () => {
  rA()
  assertMatch(String(getSettings(a).statusLine?.command), { mustMatch: [String.raw`harness-statusline\.js`], noNegative: 'presence of the wired command' })
})
si('A wiring uses command type', () => { rA(); assert.equal(getSettings(a).statusLine?.type, 'command') })
si('A wiring is reported', () => assertMatch(rA().out, { mustMatch: ['wired'], noNegative: 'presence of the report line' }))
si('A a fresh wiring carries NO refreshInterval (ADR 0122)', () => { rA(); assertAbsent(getSettings(a).statusLine?.refreshInterval, 'refreshInterval') })

// --- B: re-run is idempotent --------------------------------------------------------------------
const rB = lazy(() => { rA(); return invokeInstall(a) })
si('B re-run reports the script unchanged', () => assertMatch(rB().out, { mustMatch: [String.raw`harness-statusline\.js unchanged`], noNegative: 'presence of the report line' }))
si('B re-run reports already wired', () => assertMatch(rB().out, { mustMatch: ['already wired'], noNegative: 'presence of the report line' }))

// --- C: an edited installed copy is refreshed from canon (TOOLCHAIN) ----------------------------
const canon = fs.readFileSync(canonScript)
const rC = lazy(() => {
  rB()
  fs.writeFileSync(path.join(a, SCRIPT), '// hacked')
  return invokeInstall(a)
})
si('C an edited copy is refreshed', () => assertMatch(rC().out, { mustMatch: [String.raw`harness-statusline\.js refreshed`], noNegative: 'presence of the report line' }))
si('C the refreshed copy is byte-identical to canon', () => {
  rC()
  assert.ok(canon.equals(fs.readFileSync(path.join(a, SCRIPT))), 'copy still differs')
})

// --- C2: a REORDERED installed copy is refreshed too --------------------------------------------
// Same length, same bytes, two lines swapped: an order-blind compare would read it as unchanged.
// The swap works on bytes, because a text round trip could drop a BOM and change the length.
// It needs two distinct lines, and the first case asserts them so this one cannot go vacuous.
const e0 = canon.indexOf(10)
const e1 = e0 >= 0 ? canon.indexOf(10, e0 + 1) : -1
const rC2 = lazy(() => {
  rC()
  const tail = e1 + 1 < canon.length ? canon.subarray(e1 + 1) : Buffer.alloc(0)
  const swapped = e1 > 0 ? Buffer.concat([canon.subarray(e0 + 1, e1 + 1), canon.subarray(0, e0 + 1), tail]) : canon
  fs.writeFileSync(path.join(a, SCRIPT), swapped)
  const written = fs.readFileSync(path.join(a, SCRIPT))
  const run = invokeInstall(a)
  return { written, run, placed: fs.readFileSync(path.join(a, SCRIPT)) }
})
test('C2 fixture has two distinct lines to swap', () => {
  assert.ok(e1 > 0 && !canon.subarray(0, e0 + 1).equals(canon.subarray(e0 + 1, e1 + 1)), 'canon script too short')
})
test('C2 the swapped copy keeps the length', () => assert.equal(rC2().written.length, canon.length, `${rC2().written.length} vs ${canon.length}`))
test('C2 a reordered copy is refreshed', () => assertMatch(rC2().run.out, { mustMatch: [String.raw`harness-statusline\.js refreshed`], noNegative: 'presence of the report line' }))
test('C2 the refreshed copy is byte-identical to canon', () => assert.ok(canon.equals(rC2().placed), 'copy still differs'))

// --- D: UNRELATED SETTINGS SURVIVE ---------------------------------------------------------------
// The case that justifies parsing rather than templating the file. A rewrite that dropped a
// permission block or an env var would be silent and expensive.
const d = newDir('has-settings')
const existing = `{
  "env": { "PYTHONUTF8": "1" },
  "permissions": { "allow": ["Bash(git *)"], "defaultMode": "auto" },
  "effortLevel": "xhigh",
  "autoCompactEnabled": false
}`
const rD = lazy(() => { fs.writeFileSync(settingsPath(d), existing); return invokeInstall(d) })
si('D exits 0', () => assert.equal(rD().code, 0, `exit=${rD().code}`))
si('D env survives', () => { rD(); assert.equal(getSettings(d).env?.PYTHONUTF8, '1', 'env lost') })
si('D permissions survive', () => { rD(); assert.ok(getSettings(d).permissions?.allow?.includes('Bash(git *)'), 'permissions lost') })
si('D defaultMode survives', () => { rD(); assert.equal(getSettings(d).permissions?.defaultMode, 'auto', 'defaultMode lost') })
si('D effortLevel survives', () => { rD(); assert.equal(getSettings(d).effortLevel, 'xhigh', 'effortLevel lost') })
si('D a false boolean survives as false', () => { rD(); assert.equal(getSettings(d).autoCompactEnabled, false, `autoCompactEnabled=${getSettings(d).autoCompactEnabled}`) })
si('D statusLine was added', () => {
  rD()
  assertMatch(String(getSettings(d).statusLine?.command), { mustMatch: [String.raw`harness-statusline\.js`], noNegative: 'presence of the wired command' })
})

// --- E: a FOREIGN statusLine is refused, not overwritten ----------------------------------------
const e = newDir('foreign')
const rE = lazy(() => {
  fs.writeFileSync(settingsPath(e), '{ "statusLine": { "type": "command", "command": "node /my/own/line.js" } }')
  return invokeInstall(e)
})
si('E foreign statusLine survives byte-identical', () => { rE(); assert.equal(getSettings(e).statusLine?.command, 'node /my/own/line.js') })
si('E a foreign block gains NO refreshInterval — refusal is wholesale', () => { rE(); assertAbsent(getSettings(e).statusLine?.refreshInterval, 'refreshInterval') })
si('E refusal is reported', () => assertMatch(rE().out, { mustMatch: ['REFUSED'], noNegative: 'presence of the refusal line' }))
si('E the existing value is named', () => assertMatch(rE().out, { mustMatch: [String.raw`/my/own/line\.js`], noNegative: 'presence of the named value' }))
si('E run still exits 0', () => assert.equal(rE().code, 0, `exit=${rE().code}`))
si('E the script is still installed despite the refusal', () => assert.ok((rE(), isFile(path.join(e, SCRIPT))), 'script missing'))

// --- F: unparseable settings.json — refuse and say so, never rewrite ----------------------------
const f = newDir('broken-json')
const garbage = '{ this is not json'
const rF = lazy(() => { fs.writeFileSync(settingsPath(f), garbage); return invokeInstall(f) })
si('F unparseable settings exits 1', () => assert.equal(rF().code, 1, `exit=${rF().code} out=${rF().out}`))
si('F the file is left exactly as it was', () => { rF(); assert.equal(fs.readFileSync(settingsPath(f), 'utf8'), garbage, 'settings.json was modified') })
si('F the manual fix is printed', () => assertMatch(rF().out, { mustMatch: ['statusLine'], noNegative: 'presence of the manual snippet' }))

// --- F2: settings.json that parses but is not an object — the same refusal, never a raw error ----
// `[]`, `null` and `"x"` parse but cannot carry a key. Each must print the manual snippet, not a raw error.
// Bytes are compared, not text.
for (const [dirName, text] of [['f2-array', '[]'], ['f2-null', 'null'], ['f2-string', '"x"']]) {
  const f2Dir = newDir(dirName)
  const f2Path = settingsPath(f2Dir)
  const rF2 = lazy(() => {
    fs.writeFileSync(f2Path, text)
    const before = fs.readFileSync(f2Path)
    return { before, run: invokeInstall(f2Dir) }
  })
  test(`F2 settings.json holding ${text} exits 1, says it is not an object, and prints the manual snippet`, () => {
    const { run } = rF2()
    const pre = run.code === 1 ? [] : [`exit=${run.code}`]
    const fails = matchFailures(run.out, {
      mustMatch: ['not an object', 'Add this yourself', '"statusLine"'], mustNotMatch: ['Exception|At line:|CategoryInfo'], preFail: pre,
    })
    assert.deepEqual(fails, [], `exit=${run.code} out=${run.out}`)
  })
  test(`F2 the ${text} file is left byte-identical`, () => {
    const { before } = rF2()
    assert.ok(before.equals(fs.readFileSync(f2Path)), 'settings.json was modified')
  })
}

// --- G: dry run writes nothing -------------------------------------------------------------------
const g = newDir('dry')
const rG = lazy(() => invokeInstall(g, ['--dry-run']))
si('G dry run exits 0', () => assert.equal(rG().code, 0, `exit=${rG().code}`))
si('G dry run says so', () => assertMatch(rG().out, { mustMatch: ['dry run'], noNegative: 'presence of the dry-run notice' }))
si('G dry run wrote no script', () => assert.ok((rG(), !fs.existsSync(path.join(g, SCRIPT))), 'script was written'))
si('G dry run wrote no settings', () => assert.ok((rG(), !fs.existsSync(settingsPath(g))), 'settings.json was written'))

// --- J: a refreshInterval on OUR OWN block is kept, never added (ADR 0122) ----------------------
// Older installs carry `refreshInterval: 30` and a member may have tuned it. The script cannot tell
// the two apart, so any present value survives every re-run and is named in the output. An absent
// one is never added back.
const k = newDir('kept-interval')
const kSettings = settingsPath(k)
const rewriteK = (mutate) => {
  const map = JSON.parse(fs.readFileSync(kSettings, 'utf8'))
  mutate(map)
  fs.writeFileSync(kSettings, JSON.stringify(map, null, 2))
}
const kStep1 = lazy(() => {
  invokeInstall(k)
  rewriteK((m) => { m.statusLine.refreshInterval = 30; m.keepMe = 'yes' })   // an older install wired the interval; keepMe is an unrelated key
  const run = invokeInstall(k)
  return { run, settings: getSettings(k) }
})
si('J an old 30 s interval survives a re-run', () => assert.equal(kStep1().settings.statusLine?.refreshInterval, 30, `refreshInterval=${kStep1().settings.statusLine?.refreshInterval}`))
si('J the kept interval is named, with the way out', () =>
  assertMatch(kStep1().run.out, { mustMatch: ['already wired', String.raw`refreshInterval 30 kept — no longer wired \(ywr-harness ADR 0122\)`], noNegative: 'presence of the two report lines' }))
si('J the command wiring is untouched', () =>
  assertMatch(String(kStep1().settings.statusLine?.command), { mustMatch: [String.raw`harness-statusline\.js`], noNegative: 'presence of the wired command' }))
si('J unrelated keys survive the re-run', () => assert.equal(kStep1().settings.keepMe, 'yes', 'keepMe lost'))
// A member-tuned value survives too.
const kStep2 = lazy(() => {
  kStep1()
  rewriteK((m) => { m.statusLine.refreshInterval = 5 })
  const run = invokeInstall(k)
  return { run, settings: getSettings(k) }
})
si('J a member-tuned interval survives a re-run', () => assert.equal(kStep2().settings.statusLine?.refreshInterval, 5, `refreshInterval=${kStep2().settings.statusLine?.refreshInterval}`))
si('J the tuned value is named', () => assertMatch(kStep2().run.out, { mustMatch: ['refreshInterval 5 kept'], noNegative: 'presence of the report line' }))
// Absent on our block: never added back, real run or dry run, and no note.
const kStep3 = lazy(() => {
  kStep2()
  rewriteK((m) => { delete m.statusLine.refreshInterval })
  const dry = invokeInstall(k, ['--dry-run'])
  const real = invokeInstall(k)
  return { dry, real, settings: getSettings(k) }
})
si('J an absent interval is not added back', () => assertAbsent(kStep3().settings.statusLine?.refreshInterval, 'refreshInterval'))
si('J neither run mentions refreshInterval when there is none', () => {
  const { dry, real } = kStep3()
  assertMatch(dry.out, { mustNotMatch: ['refreshInterval'] })
  assertMatch(real.out, { mustMatch: ['already wired'], mustNotMatch: ['refreshInterval'] })
})

// --- H: the DEFAULT target follows CLAUDE_CONFIG_DIR (ADR 0046) ----------------------------------
// No --claude-dir. The env var is the scope a multi-account session runs under, and a default that
// ignored it would install into a directory that session never reads. The env var points every
// no-flag run at a fixture, so the real ~/.claude stays uninvolved.
const h = newDir('config-dir-default')
const i = newDir('explicit-beats-env')
const hStep = lazy(() => {
  const env = envWith('CLAUDE_CONFIG_DIR', h)
  const noFlag = invokeNoFlag({ env })
  // An explicit --claude-dir wins over the env var, and every fixture-pointed case depends on it.
  const explicit = invokeInstall(i, [], { env })
  return { noFlag, explicit }
})
const has = (text, sub) => String(text).toLowerCase().includes(sub.toLowerCase())
si('H no-flag run exits 0', () => assert.equal(hStep().noFlag.code, 0, `exit=${hStep().noFlag.code} out=${hStep().noFlag.out}`))
si('H no-flag run lands in CLAUDE_CONFIG_DIR', () => assert.ok((hStep(), isFile(path.join(h, SCRIPT))), hStep().noFlag.out))
si('H no-flag wiring points into CLAUDE_CONFIG_DIR', () => {
  hStep()
  const cmd = getSettings(h)?.statusLine?.command
  assert.ok(has(cmd, h), `got: ${cmd}`)
})
si('H explicit -ClaudeDir beats the env var', () => assert.ok((hStep(), isFile(path.join(i, SCRIPT))), hStep().explicit.out))
si('H explicit-dir wiring does not point at the env dir', () => {
  hStep()
  const cmd = getSettings(i)?.statusLine?.command
  assert.ok(!has(cmd, h), `got: ${cmd}`)
})

// --- I: a malformed CLAUDE_CONFIG_DIR is REFUSED, never resolved against the cwd -----------------
// A relative or blank-but-set value, such as an unexpanded '$HOME/.claude' or a stray './cfg',
// would install wherever the script ran FROM. The refusal names the value and writes nothing.
// An explicit --claude-dir stays trusted verbatim.
const j = newDir('explicit-under-bad-env')
const iStep = lazy(() => {
  const env = envWith('CLAUDE_CONFIG_DIR', 'not-absolute\\cfg')
  const refused = invokeNoFlag({ env, cwd: fxBase })
  // An explicit dir under the same malformed env still installs.
  const explicit = invokeInstall(j, [], { env })
  return { refused, explicit }
})
si('I a relative CLAUDE_CONFIG_DIR exits 1', () => assert.equal(iStep().refused.code, 1, `exit=${iStep().refused.code} out=${iStep().refused.out}`))
si('I the refusal names the variable and the value', () =>
  assertMatch(iStep().refused.out, { mustMatch: ['CLAUDE_CONFIG_DIR', 'not-absolute'], noNegative: 'presence of the named variable and value' }))
si('I nothing was created at the cwd-relative path', () => assert.ok((iStep(), !fs.existsSync(path.join(fxBase, 'not-absolute'))), 'cwd-relative dir was created'))
si('I an explicit -ClaudeDir still installs under the malformed env', () => {
  const { explicit } = iStep()
  assert.ok(explicit.code === 0 && isFile(path.join(j, SCRIPT)), `exit=${explicit.code} ${explicit.out}`)
})
