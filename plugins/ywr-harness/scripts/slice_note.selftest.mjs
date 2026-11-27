// Selftest for slice_note.mjs (ADR 0172). What can regress silently: a note that moves the work tree
// (the --tree snapshot of a ready report), a refused character that reaches the journal, a closed
// slice's notes that leak into the next slice's `show`, a range that drops the base's notes, a torn
// line that hides the rest, and a failure that reads as "no notes". Every case reads the script's
// output and exit code; the journal is read only through `show`, except where a case breaks it.
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout scripts/slice_note.selftest.mjs
//
// One throwaway repo walks the sequence from an unborn branch; N11 uses a directory outside git and
// N14 a linked worktree. Non-ASCII and control characters are built from char codes, never typed as
// escape text in this file.
//
// The cases share that repo and depend on the order, so each test does its own setup in its body. The
// node:test runner runs the tests of one file in registration order. Patterns are case-insensitive
// (see toRx in lib/selftest-lib.mjs). Git runs through harness_git.mjs, the one git subprocess
// boundary, which starts the real git binary by its absolute path.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode, toRx } from '../lib/selftest-lib.mjs'
import { git_result } from './harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const noteScript = path.join(here, 'slice_note.mjs')
const fxBase = fixtureRoot('slice-note-selftest')
after(() => removeFixtureRoot(fxBase))

// git must not climb above the fixture base: N11's plain directory has to be outside any repository.
const baseEnv = { ...process.env, GIT_CEILING_DIRECTORIES: fxBase }

const repo = path.join(fxBase, 'repo')
const plain = path.join(fxBase, 'plain')
mkdirSync(repo, { recursive: true })
mkdirSync(plain, { recursive: true })
// A git call whose failure is the case's own business never throws here; the output is read as text.
const git = (dir, args, env = {}) => git_result(dir, args, { env: { GIT_CEILING_DIRECTORIES: fxBase, ...env } })
const gitOut = (dir, args) => git(dir, args).stdout
git(repo, ['init', '-q'])
git(repo, ['config', 'user.email', 'selftest@example.invalid'])
git(repo, ['config', 'user.name', 'selftest'])

// The script's stdout and stderr together, and its exit code.
function invokeNote(dir, args, env = baseEnv) {
  const r = runNode([noteScript, '--repo', dir, ...args], { env })
  return { out: r.stdout + r.stderr, code: r.status }
}
const rx = (text, pattern) => toRx(pattern).test(text)
const check = (cond, r, extra = '') => assert.ok(cond, `exit=${r.code} out=${r.out}${extra}`)
const ch = (...c) => String.fromCharCode(...c)
const EM = ch(0x2014)    // the em dash of the script's FAILED and warning lines
const DOT = ch(0x00B7)   // the middle dot that ends the head part of a show line

test('N1 an unborn branch records HEAD none, and the text arguments join with one space', () => {
  const r = invokeNote(repo, ['add', 'decision', 'unborn', 'note'])
  check(r.code === 0 && rx(r.out, String.raw`slice note 1 recorded \(decision\) at HEAD none`), r)
})
test('N1b show lists the unborn note with its kind and joined text', () => {
  const r = invokeNote(repo, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: 1 at HEAD none') && rx(r.out, String.raw`1\. \S+Z decision: unborn note`), r)
})

let base = ''
test('N2 a commit retires the earlier notes: none at the new HEAD, one counted elsewhere', () => {
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'seed'])
  base = gitOut(repo, ['rev-parse', 'HEAD']).trim()
  const r = invokeNote(repo, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: none at HEAD [0-9a-f]{12}') && rx(r.out, 'slice notes: 1 more at other HEADs'), r)
})

const hangul = ch(0xAC00, 0xB098, 0xB2E4)
test('N3 each kind is accepted, and the count runs per HEAD', () => {
  for (const k of ['decision', 'rejected', 'owner', 'fact', 'risk']) invokeNote(repo, ['add', k, `a ${k} note`])
  const r = invokeNote(repo, ['add', 'owner', `accepted ${hangul}`])
  check(r.code === 0 && rx(r.out, String.raw`slice note 6 recorded \(owner\)`), r)
})
test('N12 notes live outside the work tree: git status stays empty', () => {
  const status = gitOut(repo, ['status', '--porcelain', '--untracked-files=all'])
  assert.ok(status.trim() === '', `status=${status}`)
})

const refusals = [
  { name: 'empty', args: ['add', 'fact', '   '], want: 'the text is empty' },
  { name: '501 characters', args: ['add', 'fact', 'x'.repeat(501)], want: 'more than 500' },
  { name: 'U+202E', args: ['add', 'risk', `bad${ch(0x202E)}x`], want: String.raw`U\+202E` },
  { name: 'LF', args: ['add', 'risk', `two${ch(10)}lines`], want: String.raw`U\+000A` },
  { name: 'U+2028', args: ['add', 'risk', `two${ch(0x2028)}lines`], want: String.raw`U\+2028` },
]
for (const c of refusals) {
  test(`N4 a note with ${c.name} text exits 2 and writes nothing`, () => {
    const r = invokeNote(repo, c.args)
    check(r.code === 2 && rx(r.out, 'slice note: REFUSED') && rx(r.out, c.want), r)
  })
}
// The bound is in UTF-16 units, as the hook's host counts a string: an astral character is two.
test('N4d 251 astral characters are 502 UTF-16 units and are refused', () => {
  const r = invokeNote(repo, ['add', 'fact', String.fromCodePoint(0x1F600).repeat(251)])
  check(r.code === 2 && rx(r.out, '502 UTF-16 units, more than 500'), r)
})
test('N4b a kind outside the closed set exits 2', () => {
  const r = invokeNote(repo, ['add', 'idea', 'not a kind'])
  check(r.code === 2 && rx(r.out, 'invalid choice'), r)
})
test('N4c --max 0 exits 2', () => {
  const r = invokeNote(repo, ['show', '--max', '0'])
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} --max`), r)
})

test('N5 show keeps the order and the Hangul text, and no refused note reached the journal', () => {
  const r = invokeNote(repo, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: 6 at HEAD') && rx(r.out, String.raw`1\. \S+Z decision: a decision note`) && rx(r.out, String.raw`5\. \S+Z risk: a risk note`)
    && r.out.includes('6. ') && r.out.includes(`owner: accepted ${hangul}`) && !rx(r.out, String.raw`7\. `), r)
})

test('N6 the next HEAD shows only its own note and counts the other seven', () => {
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'slice commit'])
  invokeNote(repo, ['add', 'rejected', 'after the commit'])
  const r = invokeNote(repo, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: 1 at HEAD') && rx(r.out, 'rejected: after the commit') && rx(r.out, 'slice notes: 7 more at other HEADs'), r)
})
test('N7 a range adds the notes at its base and its commits, not the unborn one', () => {
  const r = invokeNote(repo, ['show', '--range', `${base}..HEAD`])
  check(r.code === 0 && rx(r.out, 'slice notes: 7 at HEAD [0-9a-f]{12} and the range') && rx(r.out, 'decision: a decision note') && !rx(r.out, 'unborn note') && rx(r.out, 'slice notes: 1 more at other HEADs'), r)
})
test('N8 --all --max 2 prints the newest two with their HEADs and counts the rest', () => {
  const r = invokeNote(repo, ['show', '--all', '--max', '2'])
  check(r.code === 0 && rx(r.out, 'slice notes: 8 in the journal') && rx(r.out, String.raw`7\. \S+Z [0-9a-f]{12} owner: accepted`) && rx(r.out, String.raw`8\. \S+Z [0-9a-f]{12} rejected: after the commit`)
    && !rx(r.out, String.raw`6\. `) && rx(r.out, String.raw`slice notes: 6 older not shown \(--max 2\)`), r)
})

test('N9 a range without exactly one .. exits 2', () => {
  const r = invokeNote(repo, ['show', '--range', 'a...b'])
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} not a <a>..<b> range`), r)
})
test('N9b a range git cannot resolve exits 2, never an empty list', () => {
  const r = invokeNote(repo, ['show', '--range', 'no-such-ref..HEAD'])
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} git could not resolve`), r)
})

// The journal path is the one `rev-parse --git-path` names, relative to the repo.
let journal = ''
let nTorn
test('N10 a torn line is named on stderr and the other notes still show', () => {
  journal = path.join(repo, gitOut(repo, ['rev-parse', '--git-path', 'ywr-harness/slice-notes.jsonl']).trim())
  appendFileSync(journal, '{"ts": "torn\n')
  // A hand-written record with a well-formed text but an oversized time would grow a show line past the
  // hook's bound; every field is held to the shape `add` writes.
  appendFileSync(journal, `{"ts": "${'X'.repeat(20000)}", "head": "${gitOut(repo, ['rev-parse', 'HEAD']).trim()}", "kind": "fact", "text": "long ts"}\n`)
  const r = invokeNote(repo, ['show'])
  nTorn = r
  check(r.code === 0 && rx(r.out, String.raw`slice-notes\.jsonl:\d+ is not a slice note`) && rx(r.out, 'slice notes: 1 at HEAD'), r)
})
test('N10b a record whose ts is not the shape add writes is ignored, never printed', () => {
  const r = nTorn
  assert.ok(r && (r.out.match(/is not a slice note/gu) ?? []).length === 2 && !rx(r.out, 'long ts') && r.out.length < 4000, `exit=${r?.code} len=${r?.out.length}`)
})

test('N11 a directory outside git exits 2 with a FAILED line', () => {
  const r = invokeNote(plain, ['show'])
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} git could not resolve`), r)
})

// A git that cannot start is a git failure, not a journal fault: the child runs with a PATH holding no git.
test('N19 a git that cannot start exits 2 naming git, never a journal I/O failure or a traceback', () => {
  const noGit = path.join(fxBase, 'no-git-on-path')
  mkdirSync(noGit, { recursive: true })
  // Windows keeps one variable per name ignoring case, a plain object does not: drop every spelling of PATH first.
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => k.toUpperCase() !== 'PATH'))
  env.PATH = noGit
  const r = invokeNote(repo, ['show'], env)
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} git could not be run`) && !rx(r.out, 'journal I/O') && !rx(r.out, 'Traceback'), r)
})

test('N14 a linked worktree has its own journal', () => {
  const wt = path.join(fxBase, 'wt')
  git(repo, ['worktree', 'add', '-q', '--detach', wt])
  const r = invokeNote(wt, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: none at HEAD') && !rx(r.out, 'more at other HEADs'), r)
})

// A repo that declares a handoff: the slice runs from the last commit that touched it, so a commit
// inside the slice keeps the earlier notes, and the next close retires them.
const sliced = path.join(fxBase, 'sliced')
let closeSha = ''
test('N15 a commit inside the slice keeps the earlier notes: show runs from the last handoff commit', () => {
  mkdirSync(sliced, { recursive: true })
  writeFileSync(path.join(sliced, '.harness.json'), '{"handoff": "HANDOFF.md"}')
  writeFileSync(path.join(sliced, 'HANDOFF.md'), 'slice 1 closed')
  git(sliced, ['init', '-q'])
  git(sliced, ['config', 'user.email', 'selftest@example.invalid'])
  git(sliced, ['config', 'user.name', 'selftest'])
  git(sliced, ['add', '-A'])
  git(sliced, ['commit', '-q', '-m', 'close slice 1'])
  closeSha = gitOut(sliced, ['rev-parse', 'HEAD']).trim()
  invokeNote(sliced, ['add', 'decision', 'before the mid-slice commit'])
  writeFileSync(path.join(sliced, 'work.txt'), 'part one')
  git(sliced, ['add', '-A'])
  git(sliced, ['commit', '-q', '-m', 'mid-slice commit'])
  invokeNote(sliced, ['add', 'risk', 'after the mid-slice commit'])
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, `slice notes: 2 at HEAD [0-9a-f]{12} since the handoff commit ${closeSha.slice(0, 12)}`) && rx(r.out, 'decision: before the mid-slice commit') && rx(r.out, 'risk: after the mid-slice commit'), r)
})
// An amend and a rebase rewrite the slice's own commits; the base stays, so the notes stay.
test('N15b an amended commit keeps its notes through the base they were written under', () => {
  git(sliced, ['commit', '-q', '--amend', '--allow-empty', '-m', 'mid-slice commit, amended'])
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: 2 at HEAD') && rx(r.out, 'risk: after the mid-slice commit') && !rx(r.out, 'more at other HEADs'), r)
})
test('N15c a rebase keeps the notes too', () => {
  git(sliced, ['rebase', '-q', '--force-rebase', closeSha], { GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' })
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: 2 at HEAD') && rx(r.out, 'decision: before the mid-slice commit') && rx(r.out, 'risk: after the mid-slice commit'), r)
})
test('N16 the next close commit retires the whole slice', () => {
  writeFileSync(path.join(sliced, 'HANDOFF.md'), 'slice 2 closed')
  git(sliced, ['add', '-A'])
  git(sliced, ['commit', '-q', '-m', 'close slice 2'])
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, `slice notes: none at HEAD [0-9a-f]{12} ${DOT}`) && !rx(r.out, 'since the handoff') && rx(r.out, 'slice notes: 2 more at other HEADs'), r)
})
// A declared handoff is a literal path. As pathspec magic, `:(glob)**` would match the last commit that
// touched any file, and the empty HEAD below would then show a base.
test('N17 a handoff value never acts as pathspec magic', () => {
  git(sliced, ['commit', '-q', '--allow-empty', '-m', 'empty head'])
  writeFileSync(path.join(sliced, '.harness.json'), '{"handoff": ":(glob)**"}')
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, 'slice notes: none at HEAD') && !rx(r.out, 'since the handoff'), r)
})
test('N18 a refused handoff is named first on stdout with its effect, so the compact hook passes it on', () => {
  writeFileSync(path.join(sliced, '.harness.json'), '{"handoff": "../outside.md"}')
  const r = invokeNote(sliced, ['show'])
  check(r.code === 0 && rx(r.out, `^slice notes: warning ${EM} handoff: rejected`) && rx(r.out, 'the slice is then HEAD only'), r)
})

test('N13 a journal that cannot be written exits 2 with a FAILED line, not a traceback', () => {
  rmSync(journal, { force: true })
  mkdirSync(journal, { recursive: true })
  const r = invokeNote(repo, ['add', 'fact', 'cannot land'])
  check(r.code === 2 && rx(r.out, `slice notes: FAILED ${EM} journal I/O`) && !rx(r.out, 'Traceback'), r)
})
