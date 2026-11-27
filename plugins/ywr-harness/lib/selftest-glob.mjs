// The glob matcher of the read-set map (ywr-harness spec 0008 §3.4), shared by selftest.mjs and scripts/readset-audit.mjs.

// The .NET Regex.Escape set: the star chain below needs the stars escaped first.
const ESCAPES = { '\t': '\\t', '\n': '\\n', '\r': '\\r', '\f': '\\f', '\v': '\\v' }
const escapeRegex = (s) => s.replace(/[\\*+?|{[()^$#. \t\n\r\f\v]/g, (c) => ESCAPES[c] ?? `\\${c}`)

// Glob syntax: spec 0008 §3.4.
export function convertToGlobPattern(glob) {
  return escapeRegex(glob).replaceAll('\\*\\*/', '(?:[^\\n]*/)?').replaceAll('\\*\\*', '[^\\n]*').replaceAll('\\*', '[^/\\n]*')
}

// Null for anything but a list of non-empty strings: the caller refuses the map.
export function convertToGlobRegex(globs) {
  if (!Array.isArray(globs)) return null
  const out = []
  for (const g of globs) {
    if (typeof g !== 'string' || !g) return null
    out.push(new RegExp(`^${convertToGlobPattern(g)}$`))
  }
  return out
}

// A list may hold RegExp objects or their sources (a JSON host sends sources).
export const asRegexes = (list) => (list ?? []).map((r) => (r instanceof RegExp ? r : new RegExp(r)))

// An empty list matches nothing, so an empty `none` list claims no file (spec 0008 §3.4).
export function testAnyMatch(regexes, rel) {
  for (const rx of asRegexes(regexes)) if (rx.test(rel)) return true
  return false
}
