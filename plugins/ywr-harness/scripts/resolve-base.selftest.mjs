// Selftest for scripts/resolve-base.sh, the CI diff-range base resolution (ADR 0043).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout scripts/resolve-base.selftest.mjs
//
// Hermetic: a fixture repo in the OS temp dir holds three linear commits and a synthesized remote-tracking ref.
// So every case is deterministic everywhere, including the Linux parity container, which has no host .git.
// The mode-divergence class is the point: the same bad input (explicit dispatch base, failed PR merge-base)
// hard-fails in blocking mode and degrades with a warning (exit 0) in advisory mode.
// Every branch ends in a validated BASE or a loud degrade or error. GITHUB_OUTPUT is a per-call temp file.
// Runs via sh: /bin/sh on the ubuntu runner, Git's own sh.exe on Windows, never WSL bash (fact 12, fact 26).
// Patterns go through toRx in lib/selftest-lib.mjs, which matches case-insensitively.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, toRx } from '../lib/selftest-lib.mjs'
import { git_run, git_absent, which_on_path } from './harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, 'resolve-base.sh').replace(/\\/gu, '/')

// A missing interpreter is a skip with a reason off CI and a failure on CI: a gate that silently stopped running is not a pass.
// sh is on PATH on the ubuntu runner and in the parity container. On Windows it ships with Git, off PATH,
// so the lookup resolves it beside git.exe (<git>\cmd\..\bin\sh.exe).
function findSh() {
  const onPath = which_on_path('sh')
  if (onPath) return onPath
  const git = which_on_path('git')
  if (!git) return ''
  const cand = path.join(path.dirname(path.dirname(git)), 'bin', 'sh.exe')
  return existsSync(cand) ? cand : ''
}
const gitAbsent = git_absent()
const sh = gitAbsent ? '' : findSh()
const missing = gitAbsent ? 'git absent' : (sh ? '' : 'no sh interpreter found (PATH or Git bin)')

if (missing && process.env.CI) {
  test('RB0 interpreters present', () => { assert.fail(`${missing} on CI; a missing interpreter is not a pass`) })
} else if (missing) {
  test('RB0 interpreters present', (t) => { t.skip(`${missing} (reported, not silent) — CI runs this gate`) })
} else {
  suite()
}

function suite() {
  const fx = fixtureRoot('resolve-base-selftest')
  after(() => removeFixtureRoot(fx))

  // Fixture repo: three linear commits and a synthesized origin/<branch> at the first.
  const repo = path.join(fx, 'repo')
  git_run(fx, ['init', '-q', repo])
  const g = (...args) => git_run(repo, args)
  g('config', 'user.email', 'selftest@example.invalid')
  g('config', 'user.name', 'selftest')
  const commitFile = (rel, content, msg) => {
    writeFileSync(path.join(repo, rel), content)
    g('add', '-A')
    g('commit', '-q', '-m', msg)
  }
  commitFile('a.txt', 'one\n', 'chore: c1')
  commitFile('a.txt', 'two\n', 'chore: c2')
  commitFile('a.txt', 'three\n', 'chore: c3')
  const mainBranch = g('symbolic-ref', '--short', 'HEAD').trim()
  const c1 = g('rev-parse', 'HEAD~2').trim()
  const head1 = g('rev-parse', 'HEAD~1').trim() // the degrade target
  g('update-ref', `refs/remotes/origin/${mainBranch}`, c1)
  const badSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

  const envNames = ['EVENT_NAME', 'BASE_REF', 'EVENT_BEFORE', 'DISPATCH_BASE', 'MODE', 'GITHUB_OUTPUT']
  let n = 0

  function invokeTarget(vars) {
    const gh = path.join(fx, `gh-output-${process.pid}-${n++}.txt`)
    // Clear every script input first, so a case never inherits a prior case's vars.
    const env = { ...process.env }
    for (const k of envNames) delete env[k]
    Object.assign(env, vars)
    // Forward slashes: the sh redirect target must survive Git's sh on Windows.
    env.GITHUB_OUTPUT = gh.replace(/\\/gu, '/')
    const r = spawnSync(sh, [target], { cwd: repo, env, encoding: 'utf8', windowsHide: true })
    let base = ''
    if (existsSync(gh)) {
      const lines = readFileSync(gh, 'utf8').split(/\r?\n/u).filter((l) => /^base=/u.test(l))
      if (lines.length) base = lines[lines.length - 1].replace(/^base=/u, '')
      rmSync(gh, { force: true })
    }
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status, base }
  }
  const has = (out, pattern) => toRx(pattern).test(out)
  const detail = (r, extra = '') => `exit ${r.code}, base '${r.base}'${extra}: ${r.out}`

  // A: blocking mode, valid explicit dispatch base: passes through untouched
  test('RB1 A blocking valid base', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: head1, MODE: 'blocking' })
    assert.ok(r.code === 0 && r.base === head1, detail(r))
  })

  // B: bad explicit base, MODE unset: blocking is the default, so it hard-fails before any output.
  // An explicit operator range is never silently degraded.
  test('RB2 B blocking bad base (default mode)', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: badSha })
    assert.ok(r.code !== 0 && has(r.out, 'not an ancestor') && !r.base, detail(r))
  })

  // C: the same bad base in advisory mode: exit 0, a warning, and a degrade to HEAD~1.
  test('RB3 C advisory bad base never fails', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: badSha, MODE: 'advisory' })
    assert.ok(r.code === 0 && has(r.out, '::warning::') && r.base === head1, detail(r))
  })

  // D: push with an unreachable event.before (force-push shape): loud degrade, exit 0
  test('RB4 D push unreachable before degrades loudly', () => {
    const r = invokeTarget({ EVENT_NAME: 'push', EVENT_BEFORE: '0000000000000000000000000000000000000000' })
    assert.ok(r.code === 0 && has(r.out, 'range base unavailable') && r.base === head1, detail(r))
  })

  // E: push with a reachable event.before: passes through with no warning
  test('RB5 E push valid before passes through', () => {
    const r = invokeTarget({ EVENT_NAME: 'push', EVENT_BEFORE: head1 })
    assert.ok(r.code === 0 && r.base === head1 && !has(r.out, '::warning::'), detail(r))
  })

  // F: pull_request path: the merge-base with the synthesized origin/<branch> is exactly c1.
  test('RB6 F pull_request merge-base resolves to the fork point', () => {
    const r = invokeTarget({ EVENT_NAME: 'pull_request', BASE_REF: mainBranch })
    assert.ok(r.code === 0 && r.base === c1, detail(r, ` (want ${c1})`))
  })

  // G: PR merge-base failure in blocking mode: a loud error, never a silent empty BASE
  test('RB7 G PR merge-base failure hard-fails (blocking)', () => {
    const r = invokeTarget({ EVENT_NAME: 'pull_request', BASE_REF: '__no-such-branch__' })
    assert.ok(r.code !== 0 && has(r.out, 'cannot resolve PR merge-base') && !r.base, detail(r))
  })

  // H: the same PR failure in advisory mode: exit 0, a warning, and a degrade
  test('RB8 H PR merge-base failure degrades (advisory)', () => {
    const r = invokeTarget({ EVENT_NAME: 'pull_request', BASE_REF: '__no-such-branch__', MODE: 'advisory' })
    assert.ok(r.code === 0 && has(r.out, '::warning::') && r.base === head1, detail(r))
  })

  // I: a dispatch without a base input never hard-fails, even in blocking mode.
  // Only an explicit bad base does. An empty input is the documented degrade path.
  test('RB9 I dispatch without base degrades in blocking mode', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', MODE: 'blocking' })
    assert.ok(r.code === 0 && has(r.out, 'range base unavailable') && r.base === head1, detail(r))
  })

  // J: an unknown MODE is a loud config error, so a typo'd mode never silently flips advisory to blocking
  test('RB10 J unknown MODE fails loudly', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: badSha, MODE: 'Advisory' })
    assert.ok(r.code !== 0 && has(r.out, 'MODE must be'), detail(r))
  })

  // K: a dash-prefixed dispatch base is operator text in a git argument position.
  // It fails as a clean blocking refusal, parsed as a revision that does not resolve, never as a git option, and emits no base.
  test('RB11 K dash-prefixed base refused cleanly (blocking)', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: '--all', MODE: 'blocking' })
    assert.ok(r.code !== 0 && has(r.out, 'not an ancestor') && !r.base, detail(r))
  })
  test('K2 the same value degrades in advisory mode', () => {
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: '--all', MODE: 'advisory' })
    assert.ok(r.code === 0 && has(r.out, '::warning::') && r.base === head1, detail(r))
  })

  // L: a symbolic dispatch base (branch name) is canonicalized: the value written to $GITHUB_OUTPUT
  // is the 40-hex commit id, never the operator's text, because downstream splices it into range strings.
  test('RB12 L a ref-name base emerges as its 40-hex commit id', () => {
    g('branch', 'basemark', head1)
    const r = invokeTarget({ EVENT_NAME: 'workflow_dispatch', DISPATCH_BASE: 'basemark', MODE: 'blocking' })
    assert.ok(r.code === 0 && r.base === head1, detail(r, ` (want ${head1})`))
  })
}
