// Finds the comments of a JavaScript or sh text outside strings, so a gate reads comment text only (ADR 0234).
// Spec 0008 §3.11 states the known limits.

const NL = 10

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === NL) starts.push(i + 1)
  return starts
}

function lineAt(starts, pos) {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await'])

// Segments of kind code, comment or string (a string, template text or regex literal), in order.
// `error` names an unterminated construct with its 1-based line: the first one, except that an
// unterminated block comment replaces an earlier error.
export function jsSegments(text) {
  const segs = []
  const n = text.length
  let i = 0, codeStart = 0
  let prev = ''                       // the last significant token: '', 'word', 'value', 'close' or 'punct'
  let prevWord = ''
  let depth = 0
  const templateDepths = []
  const push = (kind, start, end) => { if (end > start) segs.push({ kind, start, end }) }
  const flushCode = (to) => push('code', codeStart, to)
  let error = null

  if (text.startsWith('#!')) {
    const eol = text.indexOf('\n')
    i = eol < 0 ? n : eol
  }

  const templateRun = (from) => {
    // From inside a template text: { end, closed }, where end follows the closing backtick or `${`; null when it never closes.
    let j = from
    while (j < n) {
      const c = text[j]
      if (c === '\\') { j += 2; continue }
      if (c === '`') return { end: j + 1, closed: true }
      if (c === '$' && text[j + 1] === '{') return { end: j + 2, closed: false }
      j++
    }
    return null
  }

  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      flushCode(i)
      let j = text.indexOf('\n', i)
      if (j < 0) j = n
      push('comment', i, j)
      i = j; codeStart = i
      continue
    }
    if (c === '/' && d === '*') {
      flushCode(i)
      const j = text.indexOf('*/', i + 2)
      if (j < 0) { error = { what: 'block comment', start: i }; push('comment', i, n); i = n; codeStart = n; break }
      push('comment', i, j + 2)
      i = j + 2; codeStart = i
      continue
    }
    if (c === '\'' || c === '"') {
      flushCode(i)
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      if (j >= n || text[j] !== c) { error = error || { what: 'string', start: i }; push('string', i, Math.min(j, n)); i = Math.min(j, n); codeStart = i; prev = 'value'; continue }
      push('string', i, j + 1)
      i = j + 1; codeStart = i; prev = 'value'
      continue
    }
    if (c === '`') {
      flushCode(i)
      const r = templateRun(i + 1)
      if (!r) { error = error || { what: 'template literal', start: i }; push('string', i, n); i = n; codeStart = n; break }
      push('string', i, r.end)
      if (!r.closed) { templateDepths.push(depth); depth++; prev = 'punct' } else prev = 'value'
      i = r.end; codeStart = i
      continue
    }
    if (c === '}' && templateDepths.length && templateDepths[templateDepths.length - 1] === depth - 1) {
      flushCode(i)
      templateDepths.pop(); depth--
      const r = templateRun(i + 1)
      if (!r) { error = error || { what: 'template literal', start: i }; push('string', i, n); i = n; codeStart = n; break }
      push('string', i, r.end)
      if (!r.closed) { templateDepths.push(depth); depth++; prev = 'punct' } else prev = 'value'
      i = r.end; codeStart = i
      continue
    }
    if (c === '/') {
      const regexHere = prev === '' || prev === 'punct' || (prev === 'word' && REGEX_AFTER_WORD.has(prevWord))
      if (regexHere) {
        let j = i + 1, inClass = false, ok = false
        while (j < n && text[j] !== '\n') {
          const ch = text[j]
          if (ch === '\\') { j += 2; continue }
          if (inClass) { if (ch === ']') inClass = false }
          else if (ch === '[') inClass = true
          else if (ch === '/') { ok = true; break }
          j++
        }
        if (ok) {
          flushCode(i)
          j++
          while (j < n && /[A-Za-z]/.test(text[j])) j++
          push('string', i, j)
          i = j; codeStart = i; prev = 'value'
          continue
        }
      }
      prev = 'punct'; i++
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$\u0080-￿]/.test(text[j])) j++
      const w = text.slice(i, j)
      if (REGEX_AFTER_WORD.has(w)) { prev = 'word'; prevWord = w } else { prev = 'value'; prevWord = '' }
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      let j = i + 1
      while (j < n && /[\w.]/.test(text[j])) j++
      prev = 'value'; i = j
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    prev = (c === ')' || c === ']' || c === '}') ? 'close' : 'punct'
    i++
  }
  flushCode(i)
  return { segs, error }
}

// Segments of a sh text. A `#` opens a comment at the start of a word outside quotes. The first line's
// `#!` is code. A quoted run and a heredoc body are strings, so `codeOnly` keeps their bytes.
export function shSegments(text) {
  const segs = []
  const n = text.length
  let i = 0, codeStart = 0, error = null, arith = 0, arithStart = 0, arithDollar = false
  const heredocs = []
  const push = (kind, start, end) => { if (end > start) segs.push({ kind, start, end }) }
  // A command `((` can be arithmetic or nested subshells, and only a `((` that closes on its line reads safely
  // as arithmetic, so any other one is reported (spec 0008 §3.11).
  const unreadable = () => ({ what: '`((` block', end: 'the lexer cannot read as arithmetic', start: arithStart })
  if (text.startsWith('#!')) { const eol = text.indexOf('\n'); i = eol < 0 ? n : eol }
  while (i < n) {
    const c = text[i]
    if (c === '\n' && arith > 0 && !arithDollar) { error = error || unreadable(); arith = 0 }
    if (c === '\n' && heredocs.length) {
      // Each pending heredoc body runs up to its delimiter line.
      push('code', codeStart, i + 1)
      let j = i + 1
      while (heredocs.length && j <= n) {
        const { word, strip } = heredocs[0]
        const eol = text.indexOf('\n', j)
        const end = eol < 0 ? n : eol
        const line = text.slice(j, end).replace(/\r$/u, '')
        if ((strip ? line.replace(/^\t+/u, '') : line) === word) heredocs.shift()
        if (eol < 0) { j = n; break }
        j = end + 1
      }
      if (heredocs.length) { error = { what: 'heredoc', start: i }; heredocs.length = 0 }
      push('string', i + 1, j)
      i = j; codeStart = i
      continue
    }
    if (c === '\\') { i += 2; continue }
    if (c === '\'' || c === '"') {
      push('code', codeStart, i)
      let j = i + 1
      if (c === '\'') { while (j < n && text[j] !== '\'') j++ } else { while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1 }
      if (j >= n) { error = error || { what: 'quoted string', start: i }; push('string', i, n); i = n; codeStart = n; break }
      push('string', i, j + 1)
      i = j + 1; codeStart = i
      continue
    }
    // `<<` inside an arithmetic `((...))` is a shift, never a heredoc.
    if (c === '(' && text[i + 1] === '(') {
      if (arith === 0) { arithStart = i; arithDollar = text[i - 1] === '$' }
      arith++; i += 2; continue
    }
    if (c === ')' && text[i + 1] === ')' && arith > 0) { arith--; i += 2; continue }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && arith === 0) {
      const m = /^<<(-?)\s*(?:\\|(['"]?))([A-Za-z_][\w]*)\2/u.exec(text.slice(i, i + 80))
      if (m) { heredocs.push({ word: m[3], strip: m[1] === '-' }); i += m[0].length; continue }
    }
    if (c === '#') {
      const before = i === 0 ? '\n' : text[i - 1]
      if (/[\s;&|()]/u.test(before)) {
        push('code', codeStart, i)
        let j = text.indexOf('\n', i)
        if (j < 0) j = n
        push('comment', i, j)
        i = j; codeStart = i
        continue
      }
    }
    i++
  }
  push('code', codeStart, n)
  if (arith > 0) error = error || unreadable()
  return { segs, error }
}

function scan(text, kind) {
  return kind === 'sh' ? shSegments(text) : jsSegments(text)
}

// The comment text of a file, one entry per physical line: { line, text }. `error` is set when a
// construct never closes or cannot be read, with its 1-based line and an optional `end` clause. The lines after it may be split wrongly, so a gate
// reports them as NOT CHECKED, never as passed.
export function commentLines(text, kind) {
  const { segs, error } = scan(text, kind)
  const starts = lineStarts(text)
  const out = []
  for (const s of segs) {
    if (s.kind !== 'comment') continue
    const first = lineAt(starts, s.start)
    text.slice(s.start, s.end).split('\n').forEach((t, k) => out.push({ line: first + k, text: t.replace(/\r$/u, '') }))
  }
  return { lines: out, error: error ? { what: error.what, end: error.end, line: lineAt(starts, error.start) } : null }
}

// The text with every comment removed and code whitespace folded: a run that holds a line break
// becomes one line break, any other run one space. Strings stay byte-exact. Two texts with equal
// results differ only in comments and in whitespace that carries no meaning.
export function codeOnly(text, kind) {
  const { segs } = scan(text, kind)
  let folded = '', buf = ''
  const flush = () => {
    folded += buf.replace(/[ \t\r\f\v]*\n[\s]*/gu, '\n').replace(/[ \t\r\f\v]+/gu, ' ')
    buf = ''
  }
  for (const s of segs) {
    const t = text.slice(s.start, s.end)
    if (s.kind === 'string') { flush(); folded += t } else if (s.kind === 'comment') buf += kind === 'sh' ? '\n' : (t.includes('\n') ? '\n' : ' ')
    else buf += t
  }
  flush()
  return folded.replace(/^\s+/u, '')
}
