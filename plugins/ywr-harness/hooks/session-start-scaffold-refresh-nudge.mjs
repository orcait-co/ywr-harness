// SessionStart (registered WITHOUT a matcher, deliberately — the drift condition below is the
// filter, and re-speaking after `compact` re-injects a fact summaries lose) — scaffold-refresh
// nudge, suggest-only (ADR 0033).
//
// The gap this closes is ADR 0014's recorded follow-up: toolchain propagation is pull-based (a
// plugin improvement reaches a scaffolded repo only on the next /ywr-harness:harness-init run),
// and nothing detected the repo that never re-ran. This hook byte-compares the installed plugin's
// templates against the repo's placements and says so when a re-run would actually change
// something — which is the only observable that matters: a version stamp would nag on hook-only
// releases and stay silent on hand-edits, this fires exactly when the files differ.
//
// The placement map (TOOLCHAIN / GUARDED / GUARD_MARKER) is read from init.ps1's own literals at
// each firing, NOT duplicated here: the hook and init.ps1 ship in the same plugin at the same
// version, so the map can never skew, and two copies of one rule is how they end up disagreeing
// (init.ps1's own header). Extraction failure is a reported EXTRACTION-DRIFT banner, never
// silence — a guard that cannot report its own drift is indistinguishable from an absent guard —
// bounded to plausible-scaffold repos (a `scripts/harness/` directory) so a broken plugin does
// not banner every unrelated session. The pwsh original walked init.ps1's PowerShell AST; Node has
// no such parser, so this port lexes init.ps1 (comments, quoted strings, here-strings, variables)
// and accepts exactly the shapes the AST walk accepted — see the "init.ps1 literal reader" block.
//
// Comparison contract (ADR 0033):
//   - TOOLCHAIN placements: EOL-insensitive byte identity (bytes compared after dropping 0x0D).
//     The seed .gitattributes pins `* eol=lf` and `*.ps1 eol=crlf`, so the SAME file legitimately
//     differs in raw bytes between the repo checkout and the installed plugin copy; a CR-only
//     delta is not a toolchain change. Everything else — content, encoding, BOM, letter case —
//     stays exact. (The pwsh original compared with `-ne`, which ignores letter case and the
//     culture-ignorable characters U+00AD and NUL; this port compares ordinally, which is what
//     this contract says.)
//   - A missing TOOLCHAIN placement counts as drift, named `(missing)`: a file the canon added
//     after this repo's last scaffold run is exactly the stale state.
//   - GUARDED (post-commit) is compared only when it carries the marker; a marker-less file is
//     foreign, init.ps1 refuses to touch it, so a re-run would change nothing — silent, the same
//     shape as the githooks-nudge's foreign-hooksPath silence (ADR 0029).
//   - SEED files are never compared: their content is the consuming repo's decisions.
//
// Direction-blindness is stated, not hidden: byte difference cannot tell "repo behind plugin"
// from "repo ahead of the installed plugin" (the canon mid-slice). The systemMessage says
// *differ*, never *outdated*, and additionalContext warns the model that a re-run would REVERT
// deliberately newer copies.
//
// Stale-basis probe (ADR 0039): a running session keeps the plugin version it loaded — hooks
// resolve to the OLD cache directory until /reload-plugins or a restart, and that directory
// survives ~2 weeks after an update (doc-verified 2026-08-07). In that window this hook's
// verdict basis is stale and its advice inverts: the repo may match the NEWER registered
// install, and the harness-init THIS session would run is the old skill (measured live: a
// v0.23.2 hook told a v0.25.0-refreshed repo to revert). So, only after drift is found, the
// hook checks whether its own copy is still the registered install — self-located from its own
// path (<plugins>/cache/<marketplace>/<name>/<version>, registry sibling at
// <plugins>/installed_plugins.json — an UNDOCUMENTED file, read best-effort like the
// statusline, ADR 0027). Stale -> same file list, but the advice becomes "reload, re-check,
// do NOT run harness-init from this session". A registered version EQUAL to the running one
// falls back to the normal nudge (same release, same templates — nothing to invert; and
// "runs vX while the install is vX" would contradict itself). Any probe failure -> the normal
// nudge: the probe can only improve the advice, never silence the hook.
//
// Direction probe (ADR 0042): after drift, the NORMAL branch reads the repo's `.harness-version`
// stamp (written by init.ps1 on every successful run — generated, never a template, never in the
// placement map, so it can never itself count as drift). stamp > running -> repo AHEAD: the
// advice flips to "update the plugin, do NOT init" (multi-writer: another writer refreshed this
// repo with a newer plugin). stamp < running -> refresh advice with the direction stated as
// measured. equal -> the drift is a hand-edit or partial placement, named as ADR 0010's intended
// signal. missing/unparseable -> direction-blind caveat, now on BOTH output surfaces (the old
// uncaveated "re-run is safe" human banner is retired — the 2026-08-10 audit's asymmetry). The
// 0039 stale-basis banner takes precedence over all of this; probe failures fall through, never
// silence.
//
// Payload and output contract: same as the sibling nudge (verified against the official hooks
// reference 2026-08-05) — cwd per firing; systemMessage AND hookSpecificOutput.additionalContext
// both consumed; plain stdout on exit 0 becomes context, so every non-speaking path prints
// NOTHING. SessionStart cannot block anything; this hook does not try — exit 0 always, fail-open
// like its siblings. This hook writes nothing, ever.
//
// The two JSON FILES it reads (the plugin manifest, the installed-plugins registry) go through hook-lib's
// parseJsonLoose — the leniency PowerShell 7's ConvertFrom-Json had (comments, trailing commas, ...);
// the stdin payload is strict JSON and keeps parseJson.
//
// Port notes (ADR 0116): event-name comparison, key lookup and the [string] cast keep
// PowerShell's semantics through hook-lib (case-insensitive lookup/compare, psString, .NET Trim).
// Without git the verdict still runs — detected by hook-lib's gitRun (no git on PATH, or ENOENT), where the original asked
// `Get-Command git`. The git call follows CLAUDE.md's git subprocess boundary (issue #40):
// `-c core.quotepath=false`, a BYTES pipe, one explicit UTF-8 decode, no shell. The hook never
// exits the process: it returns, so stdout drains and the exit code stays 0.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun } from './hook-lib.mjs'

// Drift-key order and the registry's `lastUpdated` order: case-insensitive, locale-aware (the
// original's Sort-Object and `-gt` were culture-aware), ordinal tiebreak for the key list.
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

// Test-Path -PathType Container / Leaf, promoted so every failure (a root that does not exist on
// this platform, an illegal path) reads as "not there". Leaf is a regular file: the stamp read below
// must never open a device or FIFO on the SessionStart hot path.
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// git calls go through hook-lib's gitRun (PATH-resolved, absolute spawn, bytes decoded once).
const git = gitRun

function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

// A file as UTF-8 text without a leading BOM (Get-Content -Raw's behavior for the files read below).
function readText(p) {
  let s = fs.readFileSync(p, 'utf8')
  while (s.startsWith(String.fromCharCode(0xfeff))) s = s.slice(1)
  return s
}

// PowerShell truthiness of a parsed JSON value (`if ($mf.version)`).
function psTruthy(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? psTruthy(v[0]) : true
  return true
}

// `$e.name` on a registry entry: undefined for anything that is not a JSON object.
function prop(e, name) {
  return isObject(e) ? getProp(e, name) : undefined
}

// =====================================================================================================
// init.ps1 literal reader — the AST walk's replacement
//
// The pwsh original found the FIRST assignment to $TOOLCHAIN / $GUARDED / $GUARD_MARKER anywhere in
// init.ps1 and accepted its right-hand side ONLY when it is a bare string constant (or, for the maps,
// a possibly [type]-converted hashtable literal whose every key and value is one). A computed value
// that merely CONTAINS a literal (`'prefix/' + $suffix`, an expandable "$dir/file", a nested table)
// fails extraction whole — a fragment in the map is a wrong path compared quietly (review
// 2026-08-06, high). The reader keeps that strictness: it lexes init.ps1 into tokens, finds the first
// `$NAME <assign-op>` pair, and after a string constant demands a statement end, so `'a' + $b`,
// `'a' | x`, `@{...}.Keys` and the like are refused.
//
// Not reproduced: the AST parse reported ANY syntax error in init.ps1 as an extraction failure; this
// reader fails on a lexical error (an unterminated string, here-string or block comment) and on
// unbalanced brackets — the shape a truncated or corrupted copy takes. Any other syntax error is
// init.selftest's to catch.
// =====================================================================================================
const SQ = "'‘’‚‛"        // PowerShell's single-quote characters
const DQ = '"“”„'              // ... and its double-quote characters
const WORD_STOP = new Set([...' \t\r\n\f\v;(){}[]|&,=<>$@\'"‘’‚‛“”„`'])
const ESCAPES = { 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

class LexError extends Error { }

// A single-quoted string, from `i` (just after the opening quote): '' is a literal quote.
function lexSingle(src, i) {
  let value = ''
  for (;;) {
    if (i >= src.length) throw new LexError('unterminated single-quoted string')
    if (SQ.includes(src[i])) {
      if (SQ.includes(src[i + 1] ?? '')) { value += src[i]; i += 2; continue }
      return { value, next: i + 1 }
    }
    value += src[i++]
  }
}

// A subexpression `$( ... )`, from `i` (just after the `$(`) to just past its matching `)`. Strings,
// here-strings and comments inside it are skipped as such, so a `"` or `)` inside them does not end it.
function skipSub(src, i) {
  const n = src.length
  let depth = 1
  while (i < n) {
    const c = src[i]
    if (c === '`') { i += 2; continue }
    if (SQ.includes(c)) { i = lexSingle(src, i + 1).next; continue }
    if (DQ.includes(c)) { i = lexDouble(src, i + 1, false).next; continue }
    if (c === '@' && (SQ.includes(src[i + 1] ?? '') || DQ.includes(src[i + 1] ?? ''))) {
      let j = i + 2
      while (src[j] === ' ' || src[j] === '\t' || src[j] === '\r') j++
      if (src[j] === '\n') {
        const e = hereEnd(src, j, SQ.includes(src[i + 1]) ? SQ : DQ)
        if (e < 0) throw new LexError('unterminated here-string')
        i = e + 3
        continue
      }
    }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
    i++
  }
  throw new LexError('unterminated subexpression')
}

// Index of the newline that precedes the closing `'@` / `"@` of a here-string whose opener ends at the
// newline `nl` (an empty body ends at that very newline), or -1.
function hereEnd(src, nl, quotes) {
  let k = nl - 1
  for (;;) {
    k = src.indexOf(String.fromCharCode(10), k + 1)
    if (k < 0) return -1
    if (quotes.includes(src[k + 1] ?? '') && src[k + 2] === '@') return k
  }
}

// Body of a double-quoted string or here-string, from `i` (just after the opening quote). Returns
// { value, pure, next }; pure is false when the text expands (`$name`, `${..}`, `$(..)`), which makes it
// an ExpandableString — not a bare constant. A `$( ... )` is skipped whole, quotes and all.
function lexDouble(src, i, hereString) {
  let value = ''
  let pure = true
  for (;;) {
    if (i >= src.length) throw new LexError('unterminated double-quoted string')
    const c = src[i]
    if (hereString) {
      if (c === '\n' && src[i + 1] === '"' && src[i + 2] === '@') return { value, pure, next: i + 3 }
      if (c === '\n' && DQ.includes(src[i + 1] ?? '') && src[i + 2] === '@') return { value, pure, next: i + 3 }
    } else if (DQ.includes(c)) {
      if (DQ.includes(src[i + 1] ?? '')) { value += c; i += 2; continue }   // "" -> "
      return { value, pure, next: i + 1 }
    }
    if (c === '`') {
      const n = src[i + 1] ?? ''
      value += Object.prototype.hasOwnProperty.call(ESCAPES, n) ? ESCAPES[n] : n
      i += 2
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      pure = false
      const e = skipSub(src, i + 2)
      value += src.slice(i, e)
      i = e
      continue
    }
    if (c === '$' && /[A-Za-z0-9_{?$^:]/.test(src[i + 1] ?? '')) pure = false
    value += c
    i++
  }
}

function lex(src) {
  const toks = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '\n') { toks.push({ t: 'nl' }); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ') { i++; continue }
    if (c === '`' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\n' ? 2 : 3; continue }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '<' && src[i + 1] === '#') {
      const e = src.indexOf('#>', i + 2)
      if (e < 0) throw new LexError('unterminated block comment')
      i = e + 2
      continue
    }
    if (SQ.includes(c)) {
      const r = lexSingle(src, i + 1)
      toks.push({ t: 'str', v: r.value, pure: true })
      i = r.next
      continue
    }
    if (DQ.includes(c)) {
      const r = lexDouble(src, i + 1, false)
      toks.push({ t: 'str', v: r.value, pure: r.pure })
      i = r.next
      continue
    }
    if (c === '@') {
      const q = src[i + 1] ?? ''
      if (SQ.includes(q) || DQ.includes(q)) {
        // here-string: the opener must be followed by optional blanks and a newline
        let j = i + 2
        while (src[j] === ' ' || src[j] === '\t' || src[j] === '\r') j++
        if (src[j] === '\n') {
          j++
          if (SQ.includes(q)) {
            const found = hereEnd(src, j - 1, SQ)
            if (found < 0) throw new LexError('unterminated here-string')
            let body = src.slice(j, found)
            if (body.endsWith('\r')) body = body.slice(0, -1)
            toks.push({ t: 'str', v: body, pure: true })
            i = found + 3
            continue
          }
          const r = lexDouble(src, j - 1, true)
          let body = r.value.slice(1)
          if (body.endsWith('\r')) body = body.slice(0, -1)
          toks.push({ t: 'str', v: body, pure: r.pure })
          i = r.next
          continue
        }
      }
      if (q === '{') { toks.push({ t: 'hashopen' }); i += 2; continue }
      if (q === '(') { toks.push({ t: 'other', v: '@(' }); i += 2; continue }
      toks.push({ t: 'other', v: '@' })
      i++
      continue
    }
    if (c === '$') {
      if (src[i + 1] === '{') {
        const e = src.indexOf('}', i + 2)
        if (e < 0) throw new LexError('unterminated braced variable')
        toks.push({ t: 'var', v: src.slice(i + 2, e) })
        i = e + 1
        continue
      }
      if (src[i + 1] === '(') { toks.push({ t: 'other', v: '$(' }); i += 2; continue }
      let j = i + 1
      while (j < n && /[\w:?$^]/.test(src[j])) j++
      toks.push(j > i + 1 ? { t: 'var', v: src.slice(i + 1, j) } : { t: 'other', v: '$' })
      i = Math.max(j, i + 1)
      continue
    }
    // assignment operators: = += -= *= /= %= ??=
    if (c === '=') { toks.push({ t: 'assign', v: '=' }); i++; continue }
    if ('+-*/%'.includes(c) && src[i + 1] === '=') { toks.push({ t: 'assign', v: c + '=' }); i += 2; continue }
    if (c === '?' && src[i + 1] === '?' && src[i + 2] === '=') { toks.push({ t: 'assign', v: '??=' }); i += 3; continue }
    if (c === ';') { toks.push({ t: 'semi' }); i++; continue }
    if (c === '{') { toks.push({ t: 'lbrace' }); i++; continue }
    if (c === '}') { toks.push({ t: 'rbrace' }); i++; continue }
    if (c === '[') { toks.push({ t: 'lbrack' }); i++; continue }
    if (c === ']') { toks.push({ t: 'rbrack' }); i++; continue }
    if (c === '(') { toks.push({ t: 'lparen' }); i++; continue }
    if (c === ')') { toks.push({ t: 'rparen' }); i++; continue }
    let j = i
    if (c === '`') j += 2          // a backtick escape at a token start belongs to the word
    while (j < n && !WORD_STOP.has(src[j])) j++
    if (j === i) j = i + 1         // always progress (`,` `|` `&` `<` `>` and friends)
    toks.push({ t: 'other', v: src.slice(i, j) })
    i = j
  }
  return toks
}

// A file whose brackets do not pair up is not a PowerShell script the parser would have accepted.
function balanced(toks) {
  const close = { hashopen: '}', lbrace: '}', lparen: ')', lbrack: ']' }
  const stack = []
  for (const t of toks) {
    if (close[t.t]) stack.push(close[t.t])
    else if (t.t === 'other' && (t.v === '@(' || t.v === '$(')) stack.push(')')
    else if (t.t === 'rbrace' || t.t === 'rparen' || t.t === 'rbrack') {
      const want = t.t === 'rbrace' ? '}' : t.t === 'rparen' ? ')' : ']'
      if (stack.pop() !== want) return false
    }
  }
  return stack.length === 0
}

// The token after a literal must end the statement; an operator, a pipe, a member access or a
// second token means the value was computed.
function atStatementEnd(toks, j) {
  const t = toks[j]
  return !t || t.t === 'nl' || t.t === 'semi' || t.t === 'rbrace' || t.t === 'rparen'
}

// Index of the assignment operator of the FIRST `$name <op>` in document order, or -1. The variable
// must sit directly before the operator (a newline ends the statement) and not be a typed
// left-hand side (`[string]$name = ...` is a conversion, not a variable assignment).
function findAssignment(toks, name) {
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i]
    if (t.t !== 'var' || !ieq(t.v, name) || toks[i + 1].t !== 'assign') continue
    if (i > 0 && toks[i - 1].t === 'rbrack') continue
    return i + 1
  }
  return -1
}

function afterAssign(toks, a) {
  let j = a + 1
  while (toks[j] && toks[j].t === 'nl') j++
  return j
}

// $NAME = [ordered]@{ 'k' = 'v' ... }  ->  array of [key, value] in order, or null. Any entry that is
// not a bare string constant on both sides (a computed key or value) fails the whole map.
function literalMap(toks, name) {
  const a = findAssignment(toks, name)
  if (a < 0) return null
  let j = afterAssign(toks, a)
  while (toks[j] && toks[j].t === 'lbrack') {      // [ordered] / [hashtable] conversions
    j++
    while (toks[j] && toks[j].t === 'other') j++
    if (!toks[j] || toks[j].t !== 'rbrack') return null
    j++
  }
  if (!toks[j] || toks[j].t !== 'hashopen') return null
  j++
  const entries = new Map()                          // keyed case-insensitively, in source order
  for (;;) {
    while (toks[j] && (toks[j].t === 'nl' || toks[j].t === 'semi')) j++
    const k = toks[j]
    if (!k) return null
    if (k.t === 'rbrace') { j++; break }
    let key
    if (k.t === 'str' && k.pure) key = k.v
    else if (k.t === 'other' && /^[A-Za-z_][\w.-]*$/.test(k.v)) key = k.v     // bareword key
    else return null
    j++
    if (!toks[j] || toks[j].t !== 'assign' || toks[j].v !== '=') return null
    j = afterAssign(toks, j)
    const v = toks[j]
    if (!v || v.t !== 'str' || !v.pure) return null
    j++
    if (!atStatementEnd(toks, j)) return null
    // A repeated key (case-insensitively) is a PowerShell PARSE error in a literal hashtable, which
    // failed the AST walk's whole parse — so it fails the map here too.
    if (entries.has(key.toLowerCase())) return null
    entries.set(key.toLowerCase(), [key, v.v])
  }
  if (!atStatementEnd(toks, j)) return null
  return entries.size ? [...entries.values()] : null
}

// $NAME = 'literal'  ->  the string, or null.
function literalValue(toks, name) {
  const a = findAssignment(toks, name)
  if (a < 0) return null
  const j = afterAssign(toks, a)
  const v = toks[j]
  if (!v || v.t !== 'str' || !v.pure || !atStatementEnd(toks, j + 1)) return null
  return v.v
}

// =====================================================================================================

// .NET [version] needs every component to fit Int32; the plugin's versions are far below that.
function toVersion(parts) {
  if (parts.length > 4) return null
  const p = parts.map(Number)
  while (p.length < 4) p.push(0)
  return p.some(x => !Number.isFinite(x) || x > 2147483647) ? null : p
}
function cmpVersion(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

function parent(p) {
  const d = path.dirname(p)
  return d === p ? '' : d
}

function drift(payload) {
  let keys = '(none)'
  const k = Object.keys(payload).sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
  if (k.length) keys = inline(k.join(', '), 300)
  emit({ systemMessage: `[hook:scaffold-refresh-nudge] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 이 저장소의 벤더링된 툴체인이 설치된 플러그인과 일치하는지 확인할 수 없습니다. 수신된 키: ${keys}. 페이로드 형식을 다시 확인하고 hooks/session-start-scaffold-refresh-nudge.mjs을 수정하세요 (ADR 0033).` })
}

function main(payload) {
  const cwd = netTrim(psString(getProp(payload, 'cwd')))
  if (!cwd) return drift(payload)

  // Resolve the work tree root from cwd so a subdirectory session still finds the repo. Without
  // git the verdict still runs — unlike the sibling, whose verdict IS git state, this verdict is
  // filesystem-only — using cwd as the root candidate; a subdirectory session simply stays silent
  // in that degraded case.
  let root
  const top = git(['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.absent) root = cwd
  else {
    root = firstLine(top.text)
    if (top.status !== 0 || !root) return
  }

  // Everything the banners echo of the path goes through inline(): a directory name is attacker-authorable text
  // (a cloned repo's), and a model reads this output.
  const rootShow = inline(root, 300)

  // Plausible-scaffold gate: init.ps1 places scripts/harness/ unconditionally, so a repo without
  // that directory was never scaffolded and there is nothing to verify. This is also the noise
  // bound for the extraction banner below — a broken plugin banners only where a scaffold
  // plausibly exists, not in every session on the machine.
  if (!isDir(path.join(root, 'scripts/harness'))) return

  // --- placement map, read from init.ps1's own literals (zero second copy — ADR 0033) ----------
  // process.argv[1] keeps the path as launched (the original used $PSScriptRoot, which does not
  // resolve symlinks); import.meta.url is realpath'd.
  const here = path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url))
  const pluginRoot = path.resolve(here, '..')
  const initPath = path.join(pluginRoot, 'skills/harness-init/init.ps1')
  const templatesDir = path.join(pluginRoot, 'skills/harness-init/templates')

  const extractionDrift = detail => emit({
    systemMessage: `[hook:scaffold-refresh-nudge] EXTRACTION DRIFT — ${detail} — 이 저장소(${rootShow})의 벤더링된 툴체인이 설치된 플러그인과 일치하는지는 UNKNOWN, 확인되지 않았습니다. 설치된 플러그인 자체의 파일이 일관되지 않습니다: ywr-harness를 업데이트하거나 재설치하고 이를 보고하세요 (ADR 0033).`,
  })

  let toolchain = null
  let guarded = null
  let marker = null
  if (isFile(initPath)) {
    try {
      const toks = lex(readText(initPath))
      if (!balanced(toks)) throw new LexError('unbalanced brackets')
      toolchain = literalMap(toks, 'TOOLCHAIN')
      guarded = literalMap(toks, 'GUARDED')
      marker = literalValue(toks, 'GUARD_MARKER')
    } catch { toolchain = guarded = marker = null }
  }
  if (!toolchain || !guarded || !marker) {
    return extractionDrift('설치된 플러그인의 skills/harness-init/init.ps1에서 배치 맵을 읽을 수 없습니다 ($TOOLCHAIN/$GUARDED/$GUARD_MARKER 리터럴)')
  }

  // File-level sentinel: the directory gate above is a plausibility bound; ownership is decided
  // here. A repo with its OWN scripts/harness/ but none of the mapped vendored scripts was not
  // scaffolded by us — counting everything "missing" there would be a false nudge.
  const sentinels = toolchain.map(e => e[1]).filter(v => /^scripts\/harness\/.+\.py$/i.test(v))
  if (!sentinels.length) {
    // The regex above assumes the map's CONTENTS, not just its extractability — if the canon
    // ever moves the vendored scripts, an unchecked empty list would silently disable this hook
    // on every repo forever, which is the anti-vacuity failure mode this hook exists to refuse
    // (review 2026-08-06, medium).
    return extractionDrift('추출된 배치 맵에 scripts/harness/*.py 대상이 없어, 이 훅이 기준으로 삼는 ownership sentinel이 init.ps1에서 이동했습니다')
  }
  if (!sentinels.some(s => isFile(path.join(root, s)))) return

  // EOL-insensitive comparable text: Latin1 maps bytes 1:1 to chars (byte-faithful both ways), so
  // this is a byte comparison modulo 0x0D, not a decode — a real encoding or BOM change still
  // differs.
  const comparable = p => fs.readFileSync(p).toString('latin1').replace(/\r/g, '')

  const drifted = []
  for (const [k, rel] of toolchain) {
    const src = path.join(templatesDir, k)
    const dst = path.join(root, rel)
    if (!isFile(src)) return extractionDrift(`설치된 플러그인에 템플릿이 없습니다: templates/${k}`)
    if (!isFile(dst)) { drifted.push(`${rel} (missing)`); continue }
    try { if (comparable(src) !== comparable(dst)) drifted.push(rel) } catch { drifted.push(`${rel} (unreadable)`) }
  }
  for (const [k, rel] of guarded) {
    const src = path.join(templatesDir, k)
    const dst = path.join(root, rel)
    if (!isFile(src)) return extractionDrift(`설치된 플러그인에 템플릿이 없습니다: templates/${k}`)
    if (!isFile(dst)) { drifted.push(`${rel} (missing)`); continue }
    try {
      const body = comparable(dst)
      // Marker-less = foreign = init.ps1 refuses it = a re-run changes nothing: silent.
      if (body.includes(marker) && body !== comparable(src)) drifted.push(rel)
    } catch { drifted.push(`${rel} (unreadable)`) }
  }

  if (!drifted.length) return

  let ver = 'version unknown'
  try {
    const mf = parseJsonLoose(readText(path.join(pluginRoot, '.claude-plugin/plugin.json')))
    if (isObject(mf)) {
      const v = getProp(mf, 'version')
      if (psTruthy(v)) ver = `v${psString(v)}`
    }
  } catch { /* keep 'version unknown' */ }

  // Capped list, cap stated — a silent truncation reads as full coverage.
  const shown = drifted.slice(0, 5)
  let fileList = shown.join(', ')
  if (drifted.length > shown.length) fileList += `, +${drifted.length - shown.length} more`

  // --- stale-basis probe (ADR 0039) — see the header block --------------------------------------
  // Path equality is case-insensitive: paths here are Windows-first, and on Linux a false
  // case-insensitive MATCH merely degrades to the normal nudge (the pre-0039 behavior), which is the
  // safe direction. Any failure is caught and yields null.
  const fullPath = p => {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return ''
    return path.resolve(p).replace(/[\\/]+$/, '')
  }
  let staleActive = null
  try {
    const rr = path.resolve(pluginRoot).replace(/[\\/]+$/, '')
    const nameDir = parent(rr)                     // <plugins>/cache/<marketplace>/<name>
    const mktDir = nameDir && parent(nameDir)      // <plugins>/cache/<marketplace>
    const cacheDir = mktDir && parent(mktDir)      // <plugins>/cache
    // Only a versioned cache copy can be stale-by-supersession. A --plugin-dir or repo-source
    // copy has no `cache` great-grandparent and stays on the 0033 contract (direction-blind
    // caveat), which is the correct reading for a deliberately loaded local copy.
    if (cacheDir && ieq(path.basename(cacheDir), 'cache')) {
      const pluginsDir = parent(cacheDir)
      const regPath = pluginsDir ? path.join(pluginsDir, 'installed_plugins.json') : ''
      if (regPath && isFile(regPath)) {
        const pluginName = path.basename(nameDir)
        const reg = parseJsonLoose(readText(regPath))
        // Name from the path, not plugin.json: the path IS what the registry keys index, and it
        // survives an unreadable manifest. The `@<marketplace>` half is not pinned (a consuming
        // org may register the marketplace under another name — ADR 0027).
        const plugins = isObject(reg) ? getProp(reg, 'plugins') : undefined
        const entries = []
        if (isObject(plugins)) {
          const prefix = (pluginName + '@').toUpperCase()
          for (const name of Object.keys(plugins)) {
            if (!name.toUpperCase().startsWith(prefix)) continue
            const v = plugins[name]
            if (Array.isArray(v)) entries.push(...v)
            else entries.push(v)                   // @($x) is one element — a null value is a null entry
          }
        }
        if (entries.length) {
          const current = entries.some(e => {
            const ip = fullPath(prop(e, 'installPath'))
            return ip && ieq(ip, rr)
          })
          if (!current) {
            // >=1 entry, none of them this copy: the session outlived an update (or a scope
            // re-install). Registered version for the message, the statusline's pick order as
            // spec 0010 records it: user scope wins, then lastUpdated recency — never registry
            // order. A usable version is a SCALAR STRING carrying a digit: an array would
            // space-join under [string] into a digit-bearing "1.0.0 2.0.0" that renders malformed
            // (review 2026-08-07, low); the registry's "unknown" sentinel fails the digit test.
            // Unmeasured is not a value.
            let best = null
            for (const e of entries) {
              const ev = prop(e, 'version')
              if (typeof ev !== 'string' || !/\d/.test(ev)) continue
              const eu = ieq(psString(prop(e, 'scope')), 'user')
              const bu = best !== null && ieq(psString(prop(best, 'scope')), 'user')
              if (best === null || (eu && !bu) || (eu === bu && collator.compare(psString(prop(e, 'lastUpdated')), psString(prop(best, 'lastUpdated'))) > 0)) best = e
            }
            staleActive = best ? 'v' + psString(prop(best, 'version')).replace(/^v/i, '') : 'version unknown'
            // Same version string as the running copy -> NOT stale-for-advice: a same-version
            // re-registration (cross-marketplace key, cache re-seed) ships the same templates, so
            // the refresh advice is not inverted — and "still runs $ver while the install is
            // $ver" contradicts itself (review 2026-08-07, medium). Fall back to the normal
            // nudge; the comparison is case-insensitive, and the both-'version unknown' corner
            // falls back too, which is the honest reading (nothing provable to say).
            if (ieq(staleActive, ver)) staleActive = null
          }
        }
      }
    }
  } catch { staleActive = null }

  if (staleActive) {
    const sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${drifted.length}개의 벤더링된 툴체인 파일이 이 세션의 ywr-harness (${ver}) 템플릿과 다릅니다 — ${fileList} — 하지만 비교 기준이 STALE합니다: 이 세션은 여전히 ${ver}를 실행 중이지만 이 머신에 등록된 설치는 ${staleActive}입니다. 판정이 뒤집혔을 수 있습니다 (저장소가 단순히 더 새로운 설치와 일치할 수 있습니다). /reload-plugins를 실행하거나 (또는 세션을 재시작) 다음 세션 시작 시 다시 확인하세요; 이 세션에서는 /ywr-harness:harness-init을 실행하지 마세요 — ${ver} 템플릿을 배치하게 됩니다 (ADR 0039). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0033).`
    const ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}), but the verdict basis is STALE: this session's ywr-harness hooks and skills still run ${ver} while the machine's registered install is ${staleActive} — a running session keeps the plugin version it loaded until /reload-plugins or a restart. The drift verdict may therefore be inverted: the repo may already match the newer install's templates. Do NOT run or suggest /ywr-harness:harness-init from this session — the loaded skill would place the ${ver} templates and could REVERT correctly refreshed files (ADR 0039). The remedy is /reload-plugins or a session restart, after which the next session start re-checks against the updated plugin. This surface is suggest-only (ADR 0033).`
    emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
    return
  }

  // --- direction probe (ADR 0042) — normal branch only -----------------------------------------
  // The stale-basis banner above already forbids init and takes precedence. Here, drift is real and
  // the session is current on this machine; what byte comparison cannot say is WHICH SIDE is newer
  // — and under multi-writer "another writer refreshed this repo with a newer plugin" is the
  // everyday state, not the canon-mid-slice edge 0033 accepted. `.harness-version` (written by
  // init.ps1 on every successful run) orients the advice: repo-ahead flips it to "update the
  // plugin, do NOT init"; repo-behind states the direction as measured; same-version names a
  // hand-edit; unreadable/missing falls back to direction-blind — with the caveat now on the HUMAN
  // surface too, not only in additionalContext (the 2026-08-10 audit's asymmetry). Every probe
  // failure is caught: stderr must stay clean.
  let stampVer = null
  let stampDisp = ''
  try {
    const sp = path.join(root, '.harness-version')
    if (isFile(sp)) {
      // BOUNDED read — a stamp with no newline before EOF would be read WHOLE as "line 1" by a
      // whole-file read, on the hot path of every SessionStart (review 2026-08-10, medium). 64
      // bytes is generous for a version token; anything longer becomes a clean parse failure. BOM
      // skipped; the first line is cut by hand.
      const buf = Buffer.alloc(64)
      const fd = fs.openSync(sp, 'r')
      let n
      try { n = fs.readSync(fd, buf, 0, 64, 0) } finally { fs.closeSync(fd) }
      const off = n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
      // ASCII decode as .NET does it: a byte above 0x7F becomes '?'
      let t = ''
      for (let i = off; i < n; i++) t += buf[i] > 0x7f ? '?' : String.fromCharCode(buf[i])
      const cut = t.search(/[\r\n]/)
      if (cut >= 0) t = t.slice(0, cut)
      t = netTrim(t).replace(/^v/i, '')
      if (/^\d+(\.\d+)+$/.test(t)) {
        // [version] pads unspecified components with -1, so '0.28' would compare BELOW '0.28.0'
        // and flip the direction verdict (review 2026-08-10, low). Normalize to four components
        // before comparing — the same rule as init.ps1's ConvertTo-VersionOrNull, cross-referenced
        // there; more than four stays invalid. Display keeps the raw token.
        const sv = toVersion(t.split('.'))
        if (sv) { stampVer = sv; stampDisp = `v${t}` }
      }
    }
  } catch { stampVer = null; stampDisp = '' }
  let runVer = null
  const rm = /^v(\d+(\.\d+)+)$/.exec(ver)
  if (rm) runVer = toVersion(rm[1].split('.'))

  const fileClause = `${drifted.length}개의 벤더링된 툴체인 파일이 설치된 ywr-harness (${ver}) 템플릿과 다릅니다 — ${fileList}`
  const both = stampVer && runVer
  const cmp = both ? cmpVersion(stampVer, runVer) : 0
  let sys
  let ctx
  if (both && cmp > 0) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause} — 그리고 이 저장소의 .harness-version 스탬프에 따르면 마지막으로 ywr-harness ${stampDisp} 로 스캐폴딩되었으며, 이는 이 세션의 ${ver} 보다 NEWER합니다. 저장소가 AHEAD 상태입니다: 이 세션에서 /ywr-harness:harness-init을 실행하지 마세요 — 더 오래된 ${ver} 템플릿을 배치하여 더 새로운 리프레시를 REVERT하게 됩니다 (ADR 0042). 해결 방법: /ywr-harness:update (또는 'claude plugin update')를 실행한 뒤 재시작하거나 /reload-plugins 후 다시 확인하세요. 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0033).`
    ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}), and its .harness-version stamp (${stampDisp}) is NEWER than this session's installed ywr-harness (${ver}) — another writer refreshed this repo with a newer plugin (ADR 0042). Do NOT run or suggest /ywr-harness:harness-init from this session: the loaded skill would place the ${ver} templates and REVERT the newer refresh. The remedy is updating the plugin (/ywr-harness:update or 'claude plugin update') and reloading or restarting; the next session start re-checks. This surface is suggest-only (ADR 0033).`
  } else if (both && cmp < 0) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause}. 이 저장소의 .harness-version 스탬프(${stampDisp})는 이 세션의 ${ver} 보다 OLDER합니다 — 리프레시 방향은 추측이 아니라 측정된 것입니다 (ADR 0042). 리프레시: 이 저장소에서 /ywr-harness:harness-init을 한 번 실행하고 커밋하세요 (여기서는 재실행이 안전합니다: 툴체인만 갱신되고, 시드는 보존되며, 아무것도 삭제되지 않습니다 — ADR 0010). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0033).`
    ctx = `The repo at ${rootShow} carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates (${ver}), and the repo's .harness-version stamp (${stampDisp}) is OLDER than the installed plugin — the repo is genuinely behind (ADR 0042). A /ywr-harness:harness-init re-run refreshes the toolchain from the canon and never touches seeds or accumulated ADRs. Offer the re-run when the work touches gates, hooks, or CI; do not run it unasked — this surface is suggest-only (ADR 0033).`
  } else if (both) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause} — 저장소의 .harness-version 스탬프가 이 세션의 ${ver} 와 EQUALS이므로, 이 차이는 버전 격차가 아니라 수동 편집(hand-edit) 또는 불완전한 배치입니다 (ADR 0042). /ywr-harness:harness-init을 재실행하면 수동 편집을 캐논 템플릿으로 REVERT하게 됩니다 — 이는 ADR 0010이 의도한 신호입니다 (하니스 결함은 캐논에서 고치며, 소비 저장소에서 패치하지 않습니다). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0033).`
    ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}) at the SAME version as this session's installed plugin (stamp ${stampDisp} equals ${ver}): a hand-edit or partial placement, not staleness (ADR 0042). A harness-init re-run reverts hand-edits — the intended ADR 0010 signal, but confirm the edits are not deliberate local work in progress before suggesting it. This surface is suggest-only (ADR 0033).`
  } else {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause}. CAVEAT — 이 비교는 direction-blind 상태입니다 (읽을 수 있는 .harness-version 스탬프 없음): 만약 다른 작성자가 이 머신보다 더 새로운 플러그인으로 이 저장소를 리프레시했다면, 여기서 /ywr-harness:harness-init을 재실행하면 그 리프레시를 REVERT하게 됩니다 (ADR 0042). 실행하기 전에 설치된 플러그인이 최신인지 확인하세요 (/ywr-harness:update); 그 외에는 재실행이 안전합니다 (툴체인 갱신, 시드 보존, 삭제 없음 — ADR 0010). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ADR 0033).`
    ctx = `The repo at ${rootShow} carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates (${ver}): ${fileList}. No readable .harness-version stamp, so the comparison is DIRECTION-BLIND: if this working tree deliberately carries NEWER copies than the installed plugin (the canon mid-slice, or a multi-writer repo refreshed by a newer plugin), a re-run would REVERT them to the older installed templates (ADR 0042). Offer the re-run when the work touches gates, hooks, or CI, after confirming the installed plugin is current; do not run it unasked — this surface is suggest-only (ADR 0033).`
  }
  emit({ systemMessage: sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
