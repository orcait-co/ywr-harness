// Self-test for hook-lib.mjs, the shared helpers of the plugin's Node hooks (ADR 0116).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout hooks/hook-lib.selftest.mjs
//
// No pwsh hook carries an Inline() copy any more (ADR 0142). This suite pins inline() and the other
// helpers against EXPECTED values, so the module is held to the class itself, never only to another
// copy of it. It also covers what the hooks' suites reach only through a whole hook: stdin decoding
// (BOM, empty), fail-open JSON parsing, the PowerShell `[string]` cast, and emit's one-line UTF-8 output.
//
// Every special character is built from a code point: the class under test is C0/DEL/NEL/LS/PS, and
// escape text for those can materialize as the literal character through an editor, so no such
// character, and no escape for one, appears in this source.
//
// The pwsh suite named its cases without IDs. Each test here is `HL<n> <the old name>`, so the parity
// check of ADR 0227 decision 8 matches the names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureRoot, removeFixtureRoot } from '../lib/selftest-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const libPath = path.join(here, 'hook-lib.mjs')
const lib = await import(pathToFileURL(libPath).href)

// The unit cases, in-process: each row is [name, 'OK' | 'FAIL got … want …'].
function unitRows() {
  const ch = (...c) => String.fromCharCode(...c)
  const A = 'a'
  const results = []
  const eq = (name, got, want) => results.push(got === want ? [name, 'OK'] : [name, 'FAIL got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)])
  // every member of the class becomes ONE space between letters; each is a separate case
  const members = []
  for (let c = 0; c <= 0x1f; c++) members.push(c)
  members.push(0x7f, 0x85, 0x2028, 0x2029, 0x60)
  const bad = members.filter(c => lib.inline(A + ch(c) + 'b') !== 'a b')
  eq('class: every member flattens to a space (' + members.length + ' members)', bad.map(c => c.toString(16)).join(','), '')
  // neighbours of the class are NOT flattened
  const keep = [0x20, 0x21, 0x5f, 0x61, 0x80, 0x81, 0x84, 0x86, 0x9f, 0xa1, 0x2027, 0x202a, 0x202e, 0x200b, 0xfffd]
  const flat = keep.filter(c => lib.inline(A + ch(c) + 'b') !== A + ch(c) + 'b')
  eq('neighbours of the class survive', flat.map(c => c.toString(16)).join(','), '')
  // .NET String.Trim semantics after the flatten: NBSP / ideographic space trim, U+FEFF does not
  eq('trim: U+00A0 and U+3000 at the edges are trimmed', lib.inline(ch(0xa0, 0x3000) + 'x' + ch(0x3000, 0xa0)), 'x')
  eq('trim: a class char at the edges is trimmed', lib.inline(ch(0x2028, 0x85) + 'x' + ch(0x2029, 0)), 'x')
  eq('trim: U+FEFF at the edges is kept (.NET does not trim it)', lib.inline(ch(0xfeff) + 'x' + ch(0xfeff)), ch(0xfeff) + 'x' + ch(0xfeff))
  eq('flatten before trim: only class chars -> empty', lib.inline(ch(1, 2, 0x60, 0x2028)), '')
  // the cap: max-1 characters + one ellipsis, the boundary exact
  const z = n => 'z'.repeat(n)
  const ell = ch(0x2026)
  eq('cap 80: exactly 80 is untouched', lib.inline(z(80)), z(80))
  eq('cap 80: 81 -> 79 + ellipsis', lib.inline(z(81)), z(79) + ell)
  eq('cap default is 80', lib.inline(z(200)), z(79) + ell)
  eq('cap 300 (the drift banner key list)', lib.inline(z(400), 300), z(299) + ell)
  eq('cap counts UTF-16 code units, as Substring does', lib.inline(z(78) + ch(0xd83d, 0xde00) + z(5)), z(78) + ch(0xd83d) + ell)
  eq('null and undefined render as empty', lib.inline(null) + '|' + lib.inline(undefined), '|')
  // psString: PowerShell's [string] cast
  eq('psString null/undefined -> empty, never "null"/"undefined"', lib.psString(null) + '|' + lib.psString(undefined), '|')
  eq('psString number', lib.psString(123) + '|' + lib.psString(1.5), '123|1.5')
  eq('psString boolean is True/False', lib.psString(true) + lib.psString(false), 'TrueFalse')
  eq('psString array is space-joined', lib.psString([1, 'b', null, 3]), '1 b  3')
  eq('psString object', lib.psString({ a: 1, b: 'x' }), '@{a=1; b=x}')
  // ieq / isObject / parseJson
  eq('ieq is case-insensitive', String(lib.ieq('PreToolUse', 'pretooluse')) + String(lib.ieq('a', 'b')), 'truefalse')
  eq('isObject: object yes, array/null/string no', [{}, [], null, 'x', 5].map(lib.isObject).join(','), 'true,false,false,false,false')
  eq('parseJson fails open to null', String(lib.parseJson('not json {{{')) + String(lib.parseJson('')) + JSON.stringify(lib.parseJson('{"a":1}')), 'nullnull{"a":1}')
  eq('getProp: exact case wins, else first case-insensitive match in key order, else undefined',
    [lib.getProp({ Model: 1, model: 2 }, 'model'), lib.getProp({ MODEL: 3, Model: 4 }, 'model'), lib.getProp({ a: 1 }, 'model')].join(','), '2,3,')
  // whichOnPath: PATH only (Get-Command's lookup), never the cwd or a default path; shims never count
  {
    const win = process.platform === 'win32'
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whichpath-'))
    const shim = path.join(root, 'shim'), real = path.join(root, 'real'), noexec = path.join(root, 'noexec')
    for (const d of [shim, real, noexec]) fs.mkdirSync(d)
    fs.writeFileSync(path.join(shim, 'fakegit.cmd'), '')
    const exe = path.join(real, win ? 'fakegit.exe' : 'fakegit')
    fs.writeFileSync(exe, ''); if (!win) fs.chmodSync(exe, 0o755)
    if (!win) { fs.writeFileSync(path.join(noexec, 'fakegit'), ''); fs.chmodSync(path.join(noexec, 'fakegit'), 0o644) }
    const D = path.delimiter
    eq('whichOnPath: a .cmd shim (or a non-executable file) is skipped and the real one found',
      lib.whichOnPath('fakegit', [shim, noexec, real].join(D)), exe)
    eq('whichOnPath: shim-only, empty and unset PATH find nothing (no default-path fallback)',
      [lib.whichOnPath('fakegit', shim), lib.whichOnPath('fakegit', ''), lib.whichOnPath('fakegit', undefined)].join('|'), '||')
    eq('whichOnPath: a relative entry is never searched (no cwd lookup); a quoted absolute entry is',
      [lib.whichOnPath('fakegit', 'real'), lib.whichOnPath('fakegit', '"' + real + '"')].join('|'), '|' + exe)
    fs.rmSync(root, { recursive: true, force: true })
  }
  // parseJsonLoose: what PowerShell 7.6's ConvertFrom-Json accepted in a FILE (measured side by side 2026-10-01)
  const loose = t => { try { return JSON.stringify(lib.parseJsonLoose(t)) } catch { return 'THROW' } }
  const LF = ch(10)
  eq('parseJsonLoose: // and /* */ comments', loose('{' + LF + ' // c' + LF + ' "a": /* x */ 1 }'), '{"a":1}')
  eq('parseJsonLoose: trailing commas in objects and arrays, nested', loose('{"a":{"b":[1,{"d":2,},],},}'), '{"a":{"b":[1,{"d":2}]}}')
  eq('parseJsonLoose: single quotes and unquoted keys', loose("{ 'a': 'it\\'s', b: true }"), '{"a":"it\'s","b":true}')
  eq('parseJsonLoose: comment markers inside a string are text', loose('{ "u": "http://x//y /* z */" }'), '{"u":"http://x//y /* z */"}')
  eq('parseJsonLoose: an exponent is part of the number', loose('{ "a": -1.5e3, "b": 2E-2 }'), '{"a":-1500,"b":0.02}')
  eq('parseJsonLoose: NaN / Infinity / -Infinity come back as their [string] text', loose('[NaN, Infinity, -Infinity]'), '["NaN","Infinity","-Infinity"]')
  eq('parseJsonLoose: keys of one object differing only by case are refused (ASCII and non-ASCII), as ConvertFrom-Json did',
    [loose('{"a":1,"A":2}'), loose('{ m: 1, M: 2 }'), loose('{"' + ch(0xe4) + '":1,"' + ch(0xc4) + '":2}')].join(','), 'THROW,THROW,THROW')
  eq('parseJsonLoose: case folding is .NET OrdinalIgnoreCase (simple, per code point) — sharp s/SS, the fi ligature/FI and the Turkish dotless i/I are NOT duplicates; mu/MU and final sigma/SIGMA are',
    [loose('{"' + ch(0xdf) + '":1,"SS":2}'), loose('{"' + ch(0xfb01) + '":1,"FI":2}'), loose('{"' + ch(0x131) + '":1,"I":2}'),
     loose('{"' + ch(0xb5) + '":1,"' + ch(0x39c) + '":2}'), loose('{"' + ch(0x3c2) + '":1,"' + ch(0x3a3) + '":2}')].map(r => r === 'THROW' ? 'THROW' : 'OK').join(','),
    'OK,OK,OK,THROW,THROW')
  eq('parseJsonLoose: an exact repeat is last-wins, and case-variant keys in DIFFERENT objects are fine',
    [loose('{"a":1,"a":2}'), loose('[{"a":1},{"A":2}]'), loose('{"a":{"b":1},"B":2}')].join(' '), '{"a":2} [{"a":1},{"A":2}] {"a":{"b":1},"B":2}')
  eq('parseJsonLoose: empty, blank and comment-only text is null', [loose(''), loose('  ' + LF), loose('// only')].join(','), 'null,null,null')
  eq('parseJsonLoose: refuses what PowerShell refused (# comment, doubled comma, bare word, unterminated)',
    [loose('{ # c' + LF + ' "a": 1 }'), loose('{ "a": 1,, }'), loose('{ "a": tru }'), loose('{ "a": "x }'), loose('{ "a": 1 /* x')].join(','),
    'THROW,THROW,THROW,THROW,THROW')
  eq('netTrim is .NET Trim', lib.netTrim(ch(0xa0, 0x20, 9) + 'x' + ch(0x85, 0xa0)) + '|' + (lib.netTrim(ch(0xfeff)).length), 'x|1')
  // driftKeys: the SCHEMA DRIFT key list every drift banner shares
  eq('driftKeys: no keys -> (none)', lib.driftKeys({}), '(none)')
  eq('driftKeys: case-insensitive order, ordinal tiebreak (A before a), comma-joined',
    lib.driftKeys({ cwd: 1, a: 2, Session_id: 3, A: 4, b: 5 }), 'A, a, b, cwd, Session_id')
  eq('driftKeys: a key is flattened and the list capped at 300 (inline)',
    [lib.driftKeys({ ['x' + ch(10) + 'y']: 1 }), lib.driftKeys({ [z(400)]: 1 })].join('|'), 'x y|' + z(299) + ell)
  eq('driftKeys: a lone key that flattens to nothing gives the empty string, never (none) (the hooks printed that)',
    [lib.driftKeys({ [ch(1)]: 1 }), lib.driftKeys({ [ch(0x60, 0x2028)]: 1 })].join('|'), '|')
  // psJoin: Join-Path's string shape on this platform's separator
  {
    const S = path.sep
    eq('psJoin: one separator at the join (none doubled, a leading one on the child dropped)',
      [lib.psJoin('r', 'a'), lib.psJoin('r' + S, 'a'), lib.psJoin('r', S + S + 'a'), lib.psJoin('r/', '/a')].join(' '),
      ['r' + S + 'a', 'r' + S + 'a', 'r' + S + 'a', S === '/' ? 'r/a' : 'r' + S + 'a'].join(' '))
    eq('psJoin: dot segments stay as typed; / becomes the Windows separator, never the reverse',
      lib.psJoin('r', '../b/./c'), S === '/' ? 'r/../b/./c' : 'r' + S + '..' + S + 'b' + S + '.' + S + 'c')
  }
  return results
}

let rows = []
let unitError = null
try { rows = unitRows() } catch (e) { unitError = e }
test('HL0 unit probe ran', () => { assert.equal(unitError, null, String(unitError?.stack ?? unitError)) })
test('HL0 unit probe produced results (an empty list is not a pass)', () => { assert.ok(rows.length > 0) })
for (const [name, verdict] of rows) {
  test(`HL1 inline/helpers: ${name}`, () => { assert.equal(verdict, 'OK', verdict) })
}

// readStdin and emit need a real process: stdin bytes in, stdout bytes out. The probe child imports the
// lib by URL and runs one mode.
const PROBE = [
  "import { pathToFileURL } from 'node:url'",
  'const lib = await import(pathToFileURL(process.argv[2]).href)',
  'const mode = process.argv[3]',
  'const ch = (...c) => String.fromCharCode(...c)',
  "if (mode === 'stdin') { const t = lib.readStdin(); process.stdout.write(JSON.stringify({ len: t.length, first: t.charCodeAt(0), text: t })) }",
  "if (mode === 'emit') lib.emit({ systemMessage: ch(0xd55c, 0xae00) + ' \"q\"', n: 1 })",
  '',
].join('\n')
const fx = fixtureRoot('hook-lib-selftest')
const probe = path.join(fx, 'probe.mjs')
fs.writeFileSync(probe, PROBE)
process.on('exit', () => removeFixtureRoot(fx))

// Exact bytes in, exact bytes out.
function runProbe(mode, stdin) {
  const r = spawnSync(process.execPath, [probe, libPath, mode], { input: Buffer.from(stdin ?? '', 'utf8'), windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return { bytes: r.stdout ?? Buffer.alloc(0), status: r.status }
}

test('HL2 readStdin strips every leading BOM and decodes UTF-8', () => {
  const bom = String.fromCharCode(0xfeff)
  const o = JSON.parse(runProbe('stdin', bom + '{"k":"한글"}' + bom).bytes.toString('utf8'))
  // The pwsh suite compared with -ceq, a culture compare that ignores U+FEFF, so a trailing BOM never
  // counted there. This case keeps that verdict: the leading BOMs must go, a trailing one may stay.
  const text = o.text.endsWith(bom) ? o.text.slice(0, -1) : o.text
  assert.equal(text, '{"k":"한글"}', JSON.stringify(o))
})
test('HL2 readStdin on empty stdin is the empty string', () => {
  const o = JSON.parse(runProbe('stdin', '').bytes.toString('utf8'))
  assert.equal(o.len, 0, JSON.stringify(o))
})
test('HL2 readStdin reads past one 64 KiB chunk', () => {
  const o = JSON.parse(runProbe('stdin', 'x'.repeat(300000)).bytes.toString('utf8'))
  assert.equal(o.len, 300000, `len ${o.len}`)
})
test('HL3 emit writes one compact UTF-8 JSON line, no BOM', () => {
  const r = runProbe('emit', '')
  const fails = []
  if (r.status !== 0) fails.push(`exit ${r.status}`)
  const b = r.bytes
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) fails.push('output starts with a BOM')
  const text = b.toString('utf8')
  const want = '{"systemMessage":"' + String.fromCharCode(0xd55c, 0xae00) + ' \\"q\\"","n":1}\n'
  if (text !== want) fails.push(`unexpected bytes decoded as: ${text}`)
  assert.deepEqual(fails, [], fails.join(' · '))
})
