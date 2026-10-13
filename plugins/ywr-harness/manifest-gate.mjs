#!/usr/bin/env node
// Manifest + wiring gate. Deterministic, no Claude CLI dependency, Node built-ins only (ADR 0141:
// the pwsh gate this replaces paid ~2.1 s of pwsh start and work per run; a Node prototype of its
// costly sections ran 8.7x faster). Runs identically on Windows and Linux.
//
// `claude plugin validate --strict` is the richer check but needs the CLI installed and is a
// LOCAL pre-commit habit, not a CI step: installing Claude Code on a runner to read one JSON
// file is a dependency this gate does not need. What CI must catch is the class that actually
// breaks a shipped plugin, and all of it is deterministic:
//
//   1. `version` missing — omitted `version` makes Claude Code fall back to the git commit SHA,
//      so EVERY commit becomes a new version and propagates to every consumer. This is the one
//      manifest defect with org-wide blast radius, so it is a hard failure here.
//   2. A hook path that does not resolve — the regression a file move or rename produces. The
//      plugin loads, the hook silently never runs (green selftests over a payload field name
//      nothing carries — the failure this whole gate exists to catch).
//   3. Shell form where a path placeholder is used — exec form (`args` present) is the shipped
//      decision because a marketplace install path contains a version string. A regression to
//      shell form reintroduces the quoting surface without any visible symptom.
//   4. A release-notes canon that lies (ADR 0030) — the top CHANGELOG entry disagreeing with
//      plugin.json, or the artifact link diverging between the CHANGELOG and the announce hook.
//      The hook degrades gracefully on member machines, so only this gate makes the defect loud.
//
// Port contract (ADR 0141 Decision 2): every PASS / FAIL / skip line keeps the pwsh gate's text,
// because the selftest cases and release.ps1 match that text. The pwsh semantics the cases rest on
// are kept on purpose and marked where they are not JavaScript's defaults: `-match`, `-eq`, `-in` and
// `-contains` compared case-insensitively, `[regex]::Match` case-sensitively; .NET's `\s`, `\d` and
// `\b` are Unicode classes (the S / NS / D / WB constants below); Get-ChildItem without -Force skips a
// dot-name off Windows. Spec 0008 §3.2 lists the intended differences.
//
// Exit 0 = all checks passed. Exit 1 = at least one failed. Exit 2 = the gate itself threw: never the
// 1 a caught mutation gives (ADR 0141 Decision 3). The exit code is set, never forced with
// process.exit, so stdout drains first.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'
const ESC = String.fromCharCode(27)
const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const RED = '31', GREEN = '32', YELLOW = '33'
function say(text, c) { process.stdout.write((colour && c ? `${ESC}[${c}m${text}${ESC}[0m` : text) + '\n') }

const fail = []
function bad(m) { fail.push(m); say(`FAIL  ${m}`, RED) }
function good(m) { say(`PASS  ${m}`, GREEN) }
function note(m) { say(m, YELLOW) }

// .NET regex classes, built from code points (never spell NEL, ZWNJ or ZWJ, or their escapes, in
// source: the escape text can materialize as the literal character through an editor).
const NEL = String.fromCharCode(0x85)
const S = `[\\f\\n\\r\\t\\v${NEL}\\p{Z}]`                // .NET \s
const NS = `[^\\f\\n\\r\\t\\v${NEL}\\p{Z}]`              // .NET \S
const D = '\\p{Nd}'                                      // .NET \d
const WB = `[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}${String.fromCharCode(0x200c, 0x200d)}]`   // a .NET \b word character
const rxEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

// --- file-system helpers in the pwsh cmdlets' shapes ---------------------------------------------
function stat(p) { try { return fs.statSync(p) } catch { return null } }
const exists = (p) => stat(p) !== null                    // Test-Path
const isFile = (p) => Boolean(stat(p)?.isFile())          // Test-Path -PathType Leaf
const isDir = (p) => Boolean(stat(p)?.isDirectory())      // Test-Path -PathType Container
// Get-Content's decode: a UTF-8 or UTF-16 byte-order mark picks the encoding and is dropped, else UTF-8.
function decode(b) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8')
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le')
  return b.toString('utf8')
}
const readText = (p) => decode(fs.readFileSync(p))        // Get-Content -Raw / ReadAllText
// Get-Content's lines: CRLF, CR and LF all break, and a final line break opens no extra line.
function readLines(p) {
  const t = readText(p)
  const l = t.split(/\r\n|\r|\n/)
  if (l.length && l[l.length - 1] === '') l.pop()
  return l
}
// Hidden entries: .NET marks a dot-name Hidden off Windows, and Get-ChildItem / EnumerateFiles skip
// Hidden without -Force. On Windows Hidden is a file attribute Node cannot read; no shipped file sets it.
const hidden = (name) => !WIN && name.startsWith('.')
function entryKind(dir, e) {
  if (e.isFile()) return 'file'
  if (e.isDirectory()) return 'dir'
  if (e.isSymbolicLink()) {
    const s = stat(path.join(dir, e.name))
    if (s?.isFile()) return 'file'
    if (s?.isDirectory()) return 'link-dir'               // listed, never recursed into (a reparse point)
  }
  return ''
}
let compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// Get-ChildItem -File / -Directory on one directory: names, hidden ones skipped, sorted.
function listDir(dir, kind) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const want = kind === 'dir' ? ['dir', 'link-dir'] : ['file']
  return ents.filter(e => !hidden(e.name) && want.includes(entryKind(dir, e))).map(e => e.name).sort(compare)
}
// The recursive file listing: hidden entries skipped, symlinked directories not followed.
function walkFiles(dir, out = []) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (hidden(e.name)) continue
    const k = entryKind(dir, e)
    if (k === 'file') out.push(path.join(dir, e.name))
    else if (k === 'dir') walkFiles(path.join(dir, e.name), out)
  }
  return out
}
// [IO.Path]::GetExtension: from the last dot of the name, '' when the dot ends it.
function ext(name) {
  const i = name.lastIndexOf('.')
  return i < 0 || i === name.length - 1 ? '' : name.slice(i)
}
// Split-Path -Parent: '' for a root.
function parentOf(p) { return p === path.parse(p).root ? '' : path.dirname(p) }
const leafOf = (p) => path.basename(p)                    // Split-Path -Leaf
const upper = (s) => s.toUpperCase()
const inCi = (v, list) => list.some(x => upper(x) === upper(v))   // -in / -contains
const trimQuotes = (s) => s.replace(/^['"]+|['"]+$/g, '')        // .Trim("'", '"')

// PowerShell truthiness and member access over parsed JSON.
function truthy(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 1 || (v.length === 1 && truthy(v[0]))
  return true
}

const root = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  // hook-lib owns the ConvertFrom-Json-compatible parser (fact 84) and the PATH lookup the git calls use.
  const lib = await import('./hooks/hook-lib.mjs')
  const { parseJsonLoose, psString, getProp, isObject, netTrim, gitRun, whichOnPath, collator, psJoin } = lib
  compare = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
  const prop = (o, name) => (isObject(o) ? getProp(o, name) : undefined)
  const blank = (v) => netTrim(psString(v)) === ''      // [string]::IsNullOrWhiteSpace([string]$v)
  // @($v | Where-Object { $_ }): an array's truthy elements, a truthy scalar alone, else nothing.
  const items = (v) => (Array.isArray(v) ? v : [v]).filter(truthy)
  const join = (a, b) => psJoin(a, b)

  // ONE recursive listing serves both tree scans below (namespacing, coverage), sorted so every
  // platform lists the same way; the selftest runs this gate ~80 times (handoff O31).
  const treeFiles = walkFiles(root).sort(compare)

  // --- plugin.json ---------------------------------------------------------------------------
  const mfPath = join(root, '.claude-plugin/plugin.json')
  let mf = null
  if (!exists(mfPath)) {
    bad('plugin.json not found at .claude-plugin/plugin.json')
  } else {
    try { mf = parseJsonLoose(readText(mfPath)) } catch (e) { mf = null; bad(`plugin.json does not parse: ${e.message}`) }
    if (truthy(mf)) {
      const name = psString(prop(mf, 'name'))
      if (blank(name)) bad('plugin.json: name missing')
      else if (!new RegExp('^[a-z0-9]+(-[a-z0-9]+)*\\n?$', 'iu').test(name)) bad(`plugin.json: name '${name}' is not kebab-case (used for lookup and namespacing)`)
      else good(`name = ${name}`)

      const ver = psString(prop(mf, 'version'))
      if (blank(ver)) bad('plugin.json: version MISSING — omitted version falls back to the git commit SHA, so every commit ships as a new version to every consumer')
      else if (!new RegExp(`^${D}+\\.${D}+\\.${D}+`, 'u').test(ver)) bad(`plugin.json: version '${ver}' is not semantic (major.minor.patch)`)
      else good(`version = ${ver}`)

      const dn = psString(prop(mf, 'displayName'))
      if (blank(dn)) bad('plugin.json: displayName missing — the /plugin picker would fall back to the kebab-case name')
      else good(`displayName = ${dn}`)
    }
  }
  const mfOk = truthy(mf)

  // --- hooks.json ---------------------------------------------------------------------------
  const hkPath = join(root, 'hooks/hooks.json')
  if (!exists(hkPath)) {
    bad('hooks/hooks.json not found')
  } else {
    let hk = null
    try { hk = parseJsonLoose(readText(hkPath)) } catch (e) { hk = null; bad(`hooks.json does not parse: ${e.message}`) }
    if (truthy(hk)) {
      // An empty event map is not a pass: the pwsh gate's `@($null).Count is 1` defect made this check
      // unable to fire until manifest-gate.selftest's `no-events` case caught it.
      const hooksMap = prop(hk, 'hooks')
      const events = isObject(hooksMap) ? Object.keys(hooksMap).filter(Boolean) : []
      if (events.length === 0) bad('hooks.json: no events registered (an empty hook set is not a pass)')
      else good(`events = ${events.join(', ')}`)

      const placeholderRx = /\$\{CLAUDE_(PLUGIN_ROOT|PROJECT_DIR)\}/iu
      for (const ev of events) {
        for (const matcherGroup of items(hooksMap[ev])) {
          const handlers = items(prop(matcherGroup, 'hooks'))
          if (handlers.length === 0) bad(`${ev} : registered with no handlers (an event whose hooks array is empty never runs)`)
          for (const h of handlers) {
            const args = prop(h, 'args')
            const hasArgs = args !== null && args !== undefined
            const allParts = [psString(prop(h, 'command')), ...(Array.isArray(args) ? args : [args]).map(psString)]
            if (placeholderRx.test(allParts.join(' ')) && !hasArgs) {
              bad(`${ev} : path placeholder used in shell form — set 'args' (exec form) so a marketplace install path with a version string needs no quoting`)
            }
            for (const part of allParts) {
              if (/\$\{CLAUDE_PLUGIN_ROOT\}/iu.test(part)) {
                const resolved = part.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/giu, () => root)
                if (exists(resolved)) good(`${ev} -> ${leafOf(resolved)}`)
                else bad(`${ev} : referenced path does not exist -> ${part}`)
              }
            }
          }
        }
      }

      // `modules` (Claude Mods, ADR 0117): the reference allows exactly ONE path, relative to
      // hooks.json, to a module named .js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx. A second entry, a missing
      // file or another suffix is a module the host will not load — and nothing at session start says
      // so on a member machine (the reason reaches the debug log only), so it fails here.
      if (isObject(hk) && Object.keys(hk).some(k => upper(k) === 'MODULES')) {
        const raw = getProp(hk, 'modules')
        const mods = Array.isArray(raw) ? raw : [raw]
        if (mods.length !== 1 || typeof mods[0] !== 'string' || !mods[0]) {
          bad(`hooks.json: 'modules' must hold exactly one path (got ${mods.length})`)
        } else {
          const modPath = path.resolve(join(path.dirname(hkPath), mods[0]))
          // Confined to the plugin root: a `../` path can exist in this checkout and still not be
          // in the shipped tree. The suffix compare is case-SENSITIVE: `.MJS` is not a suffix the
          // reference names, and a Linux host may not read it as one.
          const rootFull = path.resolve(root).replace(/[\\/]+$/, '') + path.sep
          if (!modPath.startsWith(rootFull)) {
            bad(`hooks.json: module '${mods[0]}' resolves outside the plugin root`)
          } else if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].includes(ext(path.basename(modPath)))) {
            bad(`hooks.json: module '${mods[0]}' has a suffix the host does not load`)
          } else if (!isFile(modPath)) {
            bad(`hooks.json: module path does not exist -> ${mods[0]}`)
          } else good(`modules -> ${leafOf(modPath)}`)
        }
      }
    }
  }

  // --- release-notes canon (ADR 0030)----------------------------------------------------------
  // The version-announce hook renders CHANGELOG.md at session start on member machines; these are
  // the two agreements that make that rendering true. Both are canon-side on purpose — the hook
  // degrades gracefully when the canon is wrong, so a defect here would otherwise ship silently.
  //   1. The top CHANGELOG entry's version must equal plugin.json's.
  //   2. The artifact release-notes-tab URL in the hook and in the CHANGELOG header must agree.
  const clPath = join(root, 'CHANGELOG.md')
  const vaPath = join(root, 'hooks/session-start-version-announce.mjs')
  if (!exists(clPath)) {
    bad('CHANGELOG.md missing — the version-announce hook would ship without its release-notes canon (ADR 0030)')
  } else {
    const clText = readText(clPath)
    let clTopVer = ''
    const topRx = new RegExp(`^##${S}+v(${D}+\\.${D}+\\.${D}+${NS}*)`, 'iu')
    for (const ln of readLines(clPath)) {
      const m = topRx.exec(ln)
      if (m) { clTopVer = m[1]; break }
    }
    // A plugin.json that does not read gets its own branch BEFORE the comparison: a skipped
    // comparison must say NOT CHECKED, never "(matches plugin.json)" (review 2026-08-05, medium —
    // the selftest pins the message, not the exit code).
    const mfVerText = psString(prop(mf, 'version'))
    if (!clTopVer) bad('CHANGELOG.md has no "## vX.Y.Z" entry — nothing for the announce hook to render')
    else if (!mfOk) bad(`CHANGELOG top entry = v${clTopVer}, but plugin.json is unreadable (see the manifest failure above) — version agreement NOT CHECKED, not passed`)
    else if (upper(clTopVer) !== upper(mfVerText)) bad(`CHANGELOG top entry is v${clTopVer} but plugin.json says ${mfVerText} — a release cannot ship without its notes (ADR 0030)`)
    else good(`CHANGELOG top entry = v${clTopVer} (matches plugin.json)`)

    // Case-insensitive hex on purpose: an uppercase artifact id would otherwise make BOTH sides
    // read empty and fail as "link missing" even when byte-identical (review 2026-08-05, low).
    const urlRx = /https:\/\/claude\.ai\/code\/artifact\/[0-9A-Fa-f-]+#rn/
    const clUrl = urlRx.exec(clText)?.[0] ?? ''
    const hkUrl = exists(vaPath) ? (urlRx.exec(readText(vaPath))?.[0] ?? '') : ''
    if (!clUrl || !hkUrl) bad(`release-notes link missing (want the artifact #rn URL in both surfaces): CHANGELOG='${clUrl}' hook='${hkUrl}'`)
    else if (upper(clUrl) !== upper(hkUrl)) bad(`release-notes link DIVERGED: CHANGELOG '${clUrl}' vs hook '${hkUrl}' — one link, two surfaces (ADR 0030)`)
    else good('release-notes link agrees across CHANGELOG.md and the announce hook')
  }

  // --- hook banner interpolation (ADR 0045) ------------------------------------------------------
  // Korean letters are LEGAL in a PowerShell variable name, so a particle glued to a variable inside
  // a double-quoted banner silently interpolates an UNDEFINED variable as EMPTY (measured live
  // 2026-08-11: both versions dropped from the banner, the suite green). Refused at build time as a
  // CLASS; comment lines are skipped (they legitimately QUOTE the trap); a hit inside a single-quoted
  // string is still refused — bracing is correct in both contexts. Scope is `hooks/*.ps1` ONLY (ADR
  // 0116): a JS template literal interpolates only through a braced `${...}`, so the trap does not
  // exist in `.mjs`. No pwsh hook ships since ADR 0142; the scan stays for the next one.
  let hookGlued = 0
  const commentRx = new RegExp(`^${S}*#`, 'u')
  const gluedRx = /\$[A-Za-z_][A-Za-z0-9_]*[가-힣]/iu
  const hooksDir = join(root, 'hooks')
  for (const name of listDir(hooksDir, 'file').filter(n => upper(ext(n)) === '.PS1' && !/\.selftest\./iu.test(n))) {
    const lines = readLines(path.join(hooksDir, name))
    for (let i = 0; i < lines.length; i++) {
      if (commentRx.test(lines[i])) continue
      if (gluedRx.test(lines[i])) {
        bad(`hooks/${name}:${i + 1} — Hangul glued to a variable name: ` +
          '"$var한글" interpolates an undefined variable named var한글 as EMPTY — brace it: "${var}한글" (ADR 0045)')
        hookGlued++
      }
    }
  }
  if (hookGlued === 0) good('hook banners: no Hangul-glued variable interpolation')

  // --- component namespacing ------------------------------------------------------------------
  // Plugin components are addressed as `<plugin>:<name>`, so an instruction that names one bare
  // fails at the point of use (measured 2026-07-26 in a live sideloaded session: the workflow loaded,
  // the shipped instruction naming it bare did not resolve). Every selftest calls the scripts
  // directly and never goes through the host's component registry; this gate is that missing check.
  // Two forms are refused: a Workflow call whose `name:` is a shipped workflow bare (runtime-fatal)
  // and a backticked slash invocation of a shipped skill bare (the reader types a dead command).
  // Headings are exempt: a skill's own H1 states its identity. Anything a reader would COPY must
  // carry the prefix.
  const pluginName = mfOk ? psString(prop(mf, 'name')) : ''
  if (pluginName) {
    const shippedWf = listDir(join(root, 'workflows'), 'file')
      .filter(n => upper(ext(n)) === '.JS' && !/\.selftest\./iu.test(n)).map(n => n.slice(0, n.length - ext(n).length))
    const shippedSkills = listDir(join(root, 'skills'), 'dir')
    const scanned = treeFiles.filter(f => inCi(ext(path.basename(f)), ['.md', '.js', '.mjs']))
    // Each pattern is built once, case-insensitive. Both refused forms carry a fixed literal, so a
    // file holding neither cannot hit and is not split into lines at all.
    const wfRx = shippedWf.map(n => ({ name: n, rx: new RegExp(`Workflow\\(\\{${S}*name:${S}*['"]${rxEscape(n)}['"]`, 'iu') }))
    const skRx = shippedSkills.map(n => ({ name: n, rx: new RegExp('`/' + rxEscape(n) + '`', 'iu') }))
    let nsBad = 0
    for (const f of scanned) {
      const text = readText(f)
      const wfHere = upper(text).includes('WORKFLOW({')
      const skHere = text.includes('`/')
      if (!(wfHere || skHere)) continue
      const lines = text.split(/\r\n|\r|\n/)
      for (let i = 0; i < lines.length; i++) {
        if (commentRx.test(lines[i])) continue           // heading: identity, not an invocation
        if (wfHere) {
          for (const w of wfRx) {
            if (w.rx.test(lines[i])) {
              bad(`${path.basename(f)}:${i + 1} — Workflow call names '${w.name}' bare; plugin components resolve as '${pluginName}:${w.name}'`)
              nsBad++
            }
          }
        }
        if (skHere) {
          for (const s of skRx) {
            if (s.rx.test(lines[i])) {
              bad(`${path.basename(f)}:${i + 1} — slash invocation \`/${s.name}\` is bare; it resolves as \`/${pluginName}:${s.name}\``)
              nsBad++
            }
          }
        }
      }
    }
    if (nsBad === 0) {
      good(`namespacing: ${shippedWf.length} workflow(s) + ${shippedSkills.length} skill(s) referenced with the '${pluginName}:' prefix`)
    }
  }

  // --- vendored-copy identity -------------------------------------------------------------------
  // The scaffold vendors the harness scripts into a consuming repo so its CI needs no access to this
  // private canon. Two copies of each script exist, which is safe only while this gate proves one
  // is generated from the other: without it, a fix applied to `scripts/` would silently not reach a
  // scaffolded repo, and the symptom would read as "the consumer is behind". Scoped to `*.py`, and
  // the scope is DECLARED: the directory also carries pure template payload with no plugin-side
  // origin by design (the first run after adding one failed the unmutated control — it worked).
  const vendorDir = join(root, 'skills/harness-init/templates/scripts/harness')
  if (isDir(vendorDir)) {
    let drift = 0
    const vendorAll = listDir(vendorDir, 'file')
    const vendorPy = vendorAll.filter(n => upper(ext(n)) === '.PY')
    const vendorPayload = vendorAll.filter(n => upper(ext(n)) !== '.PY')
    for (const v of vendorPy) {
      const origin = join(root, `scripts/${v}`)
      if (!isFile(origin)) {
        bad(`vendored templates/scripts/harness/${v} has no origin at scripts/${v}`)
        drift++
        continue
      }
      // An ORDERED byte compare: the first cut's set compare read two swapped lines as identical
      // (measured 2026-09-28).
      if (!fs.readFileSync(origin).equals(fs.readFileSync(path.join(vendorDir, v)))) {
        bad(`vendored copy DIVERGED: ${v} — re-copy scripts/${v} into skills/harness-init/templates/scripts/harness/`)
        drift++
      }
    }
    if (drift === 0) {
      const skipNote = vendorPayload.length ? ` · ${vendorPayload.length} template payload file(s) have no origin by design: ${vendorPayload.join(', ')}` : ''
      good(`vendored copies byte-identical to scripts/ (${vendorPy.length} script(s))${skipNote}`)
    }
  }

  // --- dogfood placement identity (ADR 0037 follow-up) ------------------------------------------
  // In the canon dogfood shape (<repo>/plugins/ywr-harness, ADR 0018) every scaffold placement the
  // repo carries is compared against its template. The pair list is PARSED from init.ps1's own
  // $TOOLCHAIN/$GUARDED maps — one list, one owner — and a parse that yields nothing FAILS. The
  // compare is ADR 0033's fold VERBATIM (drop every 0x0D on both sides), the contract the scaffold's
  // refresh report and the refresh-nudge hook use. GUARDED placements without the scaffold marker
  // are foreign files the scaffold refuses to touch — reported and skipped, never compared.
  const initPath = join(root, 'skills/harness-init/init.ps1')
  const repoRoot = parentOf(parentOf(root))
  // BOTH root markers: a consuming repo that vendors this plugin tree by hand has a declaration but
  // is NOT the canon (its sweep would fail on version skew, not drift — review 2026-08-07, low); the
  // dist copy carries the marketplace manifest but no declaration.
  const inTree = upper(leafOf(root)) === 'YWR-HARNESS' &&
    upper(leafOf(parentOf(root))) === 'PLUGINS' &&
    Boolean(repoRoot) && isFile(join(repoRoot, '.harness.json')) &&
    isFile(join(repoRoot, '.claude-plugin/marketplace.json'))
  if (!inTree) {
    note('dogfood placements: skipped — not the canon dogfood shape (needs .harness.json AND .claude-plugin/marketplace.json at the repo root above this plugin; a marketplace cache and a hand-vendored copy each miss one)')
  } else if (!isFile(initPath)) {
    bad('dogfood placements: init.ps1 missing — the placement map has no source to parse')
  } else {
    // [ordered]@{} keys compare case-insensitively; a repeated key keeps its first spelling.
    const placementMap = (text, varName) => {
      const m = new RegExp(`\\$${varName}${S}*=${S}*\\[ordered\\]@\\{([\\s\\S]*?)\\r?\\n\\}`, 'u').exec(text)
      if (!m) return null
      const pairs = new Map()
      for (const line of m[1].split('\n')) {
        const p = new RegExp(`^${S}*'([^']+)'${S}*=${S}*'([^']+)'`, 'iu').exec(line)
        if (p) {
          const prev = pairs.get(upper(p[1]))
          pairs.set(upper(p[1]), { rel: prev ? prev.rel : p[1], dest: p[2] })
        } else if (commentRx.test(line) || !new RegExp(NS, 'u').test(line)) {
          // comments and blanks
        } else {
          // ANYTHING else inside the block is an entry the parser cannot read; skipping it would drop
          // a pair while the sweep still counts >0 (review 2026-08-07, medium).
          bad(`dogfood placements: unparsed entry line in $${varName} of init.ps1 — ${netTrim(line)} (single-quoted 'src' = 'dest' is the parsed form)`)
        }
      }
      return [...pairs.values()]
    }
    const initText = readText(initPath)
    const tool = placementMap(initText, 'TOOLCHAIN')
    const guard = placementMap(initText, 'GUARDED')
    const markerM = new RegExp(`\\$GUARD_MARKER${S}*=${S}*'([^']+)'`, 'u').exec(initText)
    // BOTH maps non-null AND non-empty (review 2026-08-07, high): a block whose lines all fail to
    // parse returns an empty map, and a null-check alone lets that family's coverage vanish.
    if (!tool || tool.length === 0 || !guard || guard.length === 0 || !markerM) {
      bad(`dogfood placements: could not parse $TOOLCHAIN/$GUARDED/$GUARD_MARKER from init.ps1 — an empty sweep is not a pass (toolchain=${tool ? tool.length : 'none'} guarded=${guard ? guard.length : 'none'})`)
    } else {
      const folded = (p) => { const b = fs.readFileSync(p); return b.includes(13) ? b.filter(x => x !== 13) : b }
      const markerRx = new RegExp(rxEscape(markerM[1]), 'iu')
      let pDrift = 0, pChecked = 0
      const pAbsent = [], pForeign = []
      for (const fam of [{ map: tool, guarded: false }, { map: guard, guarded: true }]) {
        for (const { rel, dest } of fam.map) {
          const t = join(root, `skills/harness-init/templates/${rel}`)
          const d = join(repoRoot, dest)
          if (!isFile(t)) {
            bad(`dogfood placements: init.ps1 maps '${rel}' but the template does not exist`)
            pDrift++
            continue
          }
          if (!isFile(d)) { pAbsent.push(dest); continue }
          if (fam.guarded && !markerRx.test(readText(d))) { pForeign.push(dest); continue }
          pChecked++
          if (!Buffer.from(folded(t)).equals(Buffer.from(folded(d)))) {
            bad(`dogfood placement DIVERGED: ${dest} — re-run the scaffold refresh (/ywr-harness:harness-init) or fix the template; drift here ships a different gate than the canon reviews`)
            pDrift++
          }
        }
      }
      if (pDrift === 0) {
        const notes = []
        if (pAbsent.length) notes.push(`${pAbsent.length} not placed here: ${pAbsent.join(', ')}`)
        if (pForeign.length) notes.push(`${pForeign.length} foreign (no scaffold marker), skipped as the scaffold does: ${pForeign.join(', ')}`)
        good(`dogfood placements identical to templates (${pChecked} checked, CR-fold compare per ADR 0033` + (notes.length ? ' · ' + notes.join(' · ') : '') + ')')
      }
    }
  }

  // --- release lockstep (ADR 0073) --------------------------------------------------------------
  // A released version number must name ONE shipped tree: the scaffold stamps the placing plugin's
  // version (ADR 0042) and attributes same-version drift to a local hand edit (ADR 0067). When a
  // local tag names plugin.json's version, plugins/ywr-harness in the WORKING TREE (an uncommitted
  // edit and an untracked new file both count) must equal that tag's tree, CR-only differences
  // aside (ADR 0033's fold). Canon shape only; no tag => unreleased, said so, never silent. A
  // tag-less shallow clone reads the same line, which is why the fetch-depth-0 script gate
  // (harness-gates.yml) is the enforcing CI leg.
  const gitExe = whichOnPath('git')
  const insideWorkTree = () => gitRun(['-C', repoRoot, 'rev-parse', '--is-inside-work-tree']).status === 0
  if (!inTree) {
    note('release lockstep: skipped — not the canon dogfood shape (the release tag lives in the canon history; a marketplace cache and a hand-vendored copy have none)')
  } else {
    const mfVer = mfOk ? psString(prop(mf, 'version')) : ''
    if (!mfVer) {
      bad('release lockstep: plugin.json version unreadable (see the manifest failure above) — NOT CHECKED, not passed')
    } else if (!new RegExp(`^${D}+\\.${D}+\\.${D}+\\n?$`, 'u').test(mfVer)) {
      // The manifest check accepts a suffix; a ref name cannot (review 2026-09-03, low).
      bad(`release lockstep: plugin.json version '${mfVer}' is not a plain major.minor.patch, so the release tag name cannot be derived — NOT CHECKED, not passed`)
    } else if (!gitExe) {
      note('release lockstep: skipped — git not on PATH (reported, not silent)')
    } else if (!insideWorkTree()) {
      note('release lockstep: skipped — the canon shape is not inside a git work tree, so there is no tag history to compare (reported, not silent)')
    } else {
      const relTag = `ywr-harness--v${mfVer}`
      if (gitRun(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/tags/${relTag}^{commit}`]).status !== 0) {
        good(`release lockstep: no local tag ${relTag} — v${mfVer} is unreleased in this clone, nothing to compare (a tag-less shallow clone reads the same; the fetch-depth-0 script gate is the enforcing CI leg)`)
      } else {
        // Both lists are NUL-framed and decoded once as UTF-8 (gitRun, the CLAUDE.md git boundary):
        // a misdecoded name matches no path, and --quiet on an empty match exits 0, which would read
        // a moved file as identical.
        const diff = gitRun(['-C', repoRoot, 'diff', '--name-only', '-z', '--ignore-cr-at-eol', relTag, '--', 'plugins/ywr-harness'])
        const others = gitRun(['-C', repoRoot, 'ls-files', '-z', '--others', '--exclude-standard', '--', 'plugins/ywr-harness'])
        if (diff.status !== 0 || others.status !== 0) {
          bad(`release lockstep: git diff / ls-files against ${relTag} failed (exit ${diff.status ?? -1} / ${others.status ?? -1}) — NOT CHECKED, not passed`)
        } else {
          // git 2.34 (the Linux parity image's at ADR 0102) does not apply --ignore-cr-at-eol to
          // --name-only's list. Each candidate is re-asked with --quiet, which does: exit 0 = identical
          // once CR is ignored (dropped); any other exit keeps the file, so a failed check reads as
          // moved, never as identical. The pathspec is literal, so a glob-shaped name is itself.
          const changed = diff.text.split('\0').filter(f => f.trim())
            .filter(f => gitRun(['-C', repoRoot, 'diff', '--quiet', '--ignore-cr-at-eol', relTag, '--', `:(literal)${f}`]).status !== 0)
          const untracked = others.text.split('\0').filter(f => f.trim())
          const moved = [...new Set([...changed, ...untracked])].sort(compare)
          if (moved.length) {
            bad(`release lockstep BROKEN: ${moved.length} file(s) under plugins/ywr-harness differ from tag ${relTag} while plugin.json still says ${mfVer} — a released version must name ONE tree (ADR 0073). Bump plugin.json + .claude-plugin/marketplace.json + the CHANGELOG top entry in THIS commit: ` + moved.join(', '))
          } else {
            good(`release lockstep: plugins/ywr-harness identical to tag ${relTag}`)
          }
        }
      }
    }
  }

  // --- eval suite structure (ADR 0076 / spec 0014) -------------------------------------------------
  // `claude plugin eval` runs the cases under evals/ as PAID model calls, and three of its refusals
  // surface only at run time: an unknown prompt.md frontmatter key, a grader with an unknown `type`,
  // and a case with no grader. This section refuses them here, plus the house rule the host cannot
  // know: every case pins `model:` to a bare worker ALIAS (opus, sonnet or haiku; ADR 0103, ADR 0107),
  // case-sensitive and anchored — an unpinned case runs on the operator's session default, a Fable
  // pin draws the separate weekly cap, and a full id freezes the suite on one release. The key and
  // type sets are the documented ones (plugin-evals reference, read 2026-09-14): a documented key
  // this list lacks fails loudly and is added in the same reviewed commit. A case.yaml-only case is
  // accepted as-is; `results/` is the runner's output tree, never a case.
  let evalDirName = 'evals'
  const expo = prop(mf, 'experimental')
  if (mfOk && truthy(expo) && truthy(prop(expo, 'evals'))) evalDirName = psString(prop(expo, 'evals'))
  const evalDir = join(root, evalDirName)
  if (!isDir(evalDir)) {
    note(`eval suite: none — no ${evalDirName}/ directory in this plugin (reported, not failed)`)
  } else {
    const promptKeys = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome',
      'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']
    const graderTypes = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline']
    const workerModelRx = /^(opus|sonnet|haiku)\n?$/
    const keyRx = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)${S}*:${S}*([^\\n]*)$`, 'iu')
    const startsNonSpace = new RegExp(`^${NS}`, 'u')
    // Top-level keys only: nested YAML lines are indented and stay out of the key set. Every OTHER
    // column-0 line inside the block comes back UNPARSED and is refused by the caller: a key the
    // regex cannot read is exactly a key the unknown-key loop would never see (review 2026-09-14,
    // high). Keys compare case-insensitively ([ordered]@{}), the first spelling kept.
    const frontmatter = (p) => {
      const lines = readLines(p)
      const map = new Map()
      const unparsed = []
      if (lines.length === 0 || netTrim(lines[0]) !== '---') return null
      for (let i = 1; i < lines.length; i++) {
        if (netTrim(lines[i]) === '---') return { map, unparsed }
        const m = keyRx.exec(lines[i])
        if (m) {
          const prev = map.get(upper(m[1]))
          map.set(upper(m[1]), { key: prev ? prev.key : m[1], value: netTrim(m[2]) })
        } else if (startsNonSpace.test(lines[i]) && !lines[i].startsWith('#')) unparsed.push(`${i + 1}: ${netTrim(lines[i])}`)
      }
      return null   // opened, never closed
    }
    const fmGet = (fm, k) => fm?.map.get(upper(k))?.value
    let evalBad = 0
    const resultsRx = /[\\/]results[\\/]/iu
    const cases = walkFiles(evalDir).filter(f => upper(path.basename(f)) === 'PROMPT.MD' && !resultsRx.test(f)).sort(compare)
    let graderCount = 0
    const models = []
    for (const c of cases) {
      const caseDir = path.dirname(c)
      const caseName = caseDir.slice(evalDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      const fm = frontmatter(c)
      if (fm === null) {
        bad(`eval case ${caseName} : prompt.md has no closed frontmatter block — run limits and the model pin are unreadable`)
        evalBad++
        continue
      }
      for (const u of fm.unparsed) {
        bad(`eval case ${caseName} : prompt.md frontmatter line ${u} is not a readable 'key: value' — the gate cannot tell a typo from a nested block here, and the runner refuses it after the run is paid for`)
        evalBad++
      }
      for (const { key } of fm.map.values()) {
        if (!inCi(key, promptKeys)) {
          bad(`eval case ${caseName} : unknown prompt.md key '${key}' — the runner refuses it at run time, after the run is paid for`)
          evalBad++
        }
      }
      const model = trimQuotes(fmGet(fm, 'model') ?? '')
      if (!model) {
        bad(`eval case ${caseName} : model not pinned — the case would run on the operator's session default (org guide: workers never inherit the session model; ADR 0076)`)
        evalBad++
      } else if (!workerModelRx.test(model)) {
        bad(`eval case ${caseName} : model '${model}' is not a worker model alias (opus/sonnet/haiku, bare) — a full id freezes the suite on an old release, and scores must never draw the Fable weekly cap (ADR 0076, ADR 0107)`)
        evalBad++
      } else {
        models.push(model)
      }
      const graderDir = path.join(caseDir, 'graders')
      const graders = listDir(graderDir, 'file').filter(n => upper(ext(n)) === '.MD')
      if (graders.length === 0) {
        bad(`eval case ${caseName} : no graders/*.md — a case with nothing to grade scores nothing and still costs its runs`)
        evalBad++
      }
      for (const g of graders) {
        graderCount++
        const gfm = frontmatter(path.join(graderDir, g))
        for (const u of gfm ? gfm.unparsed : []) {
          bad(`eval case ${caseName} : grader ${g} frontmatter line ${u} is not a readable 'key: value'`)
          evalBad++
        }
        const gtype = trimQuotes(fmGet(gfm, 'type') ?? '')
        if (!gtype) {
          bad(`eval case ${caseName} : grader ${g} has no readable 'type' in its frontmatter`)
          evalBad++
        } else if (!inCi(gtype, graderTypes)) {
          bad(`eval case ${caseName} : grader ${g} type '${gtype}' is not one of ${graderTypes.join('/')} — it fails to load at run time`)
          evalBad++
        }
      }
    }
    // The negative guard's scope (spec 0014 §4.2): its `input_match` counts only Skill calls naming a
    // `disable-model-invocation` skill and lists those skills by hand, so a sixth disabled skill would
    // fall out of the guard with every run still green. Checked by MATCHING: each disabled skill's call
    // input, bare and `<plugin name>:`-namespaced, must match, and each model-invocable skill's must
    // not. The input is shaped as the runner JSON-encodes it. This gate matches with JavaScript, as the
    // runner does; the constructs .NET and JavaScript read differently stay refused (ADR 0141 Decision
    // 2 keeps the pwsh gate's behavior). A flag value other than true/false is refused rather than read
    // as "not disabled" (a validator that only sees what it parsed).
    const guardName = 'disabled-skills-stay-user-invoked/graders/no-skill-invoked.md'
    const guardPath = join(evalDir, guardName)
    let guardSkills = 0
    let guardNote = ''
    if (isFile(guardPath)) {
      const gfm = frontmatter(guardPath)
      let rx = fmGet(gfm, 'input_match') ?? ''
      if (rx.length >= 2 && rx.startsWith("'") && rx.endsWith("'")) rx = rx.slice(1, -1).replace(/''/g, "'")
      let guardRx = null
      if (!rx) {
        bad(`eval case ${guardName} : no input_match — the guard counts every Skill call, a subagent's built-in skill included (spec 0014 run #9)`)
        evalBad++
      } else if (/\(\?[<>=!a-zA-Z(]|\\[pPAZzG]|[*+?}]\+/iu.test(rx)) {
        bad(`eval case ${guardName} : input_match uses a construct .NET and JS read differently ('${rx}') — this gate could not vouch for what the runner matches`)
        evalBad++
      } else if (!pluginName) {
        bad(`eval case ${guardName} : plugin.json has no name — the namespaced skill form is unknown, so the guard's scope is not checked`)
        evalBad++
      } else {
        try { guardRx = new RegExp(rx) } catch (e) {
          bad(`eval case ${guardName} : input_match does not compile — ${e.message}`)
          evalBad++
        }
      }
      if (guardRx) {
        const skillsDir = join(root, 'skills')
        for (const sd of listDir(skillsDir, 'dir').filter(n => isFile(path.join(skillsDir, n, 'SKILL.md')))) {
          const raw = readText(path.join(skillsDir, sd, 'SKILL.md'))
          const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''
          // (?m)^key:[ \t]*(.*?)[ \t]*$ as .NET reads it: `$` before LF only, so a CR stays in the value.
          let flag = 'false'
          for (const line of front.split('\n')) {
            const m = /^disable-model-invocation:[ \t]*([^\n]*?)[ \t]*$/iu.exec(line)
            if (m) { flag = trimQuotes(m[1].replace(new RegExp(`${S}+#[^\\n]*$`, 'u'), '')); break }
          }
          if (!inCi(flag, ['true', 'false'])) {
            bad(`skill ${sd} : disable-model-invocation value '${flag}' is not true/false — the guard-scope check cannot tell whether the model may invoke it`)
            evalBad++
            continue
          }
          const disabled = upper(flag) === 'TRUE'
          if (disabled) guardSkills++
          for (const form of [sd, `${pluginName}:${sd}`]) {
            const hit = guardRx.test('{"skill":"' + form + '"}')
            if (disabled && !hit) {
              bad(`eval case ${guardName} : input_match misses '${form}' — a disable-model-invocation skill the guard no longer watches`)
              evalBad++
            } else if (!disabled && hit) {
              bad(`eval case ${guardName} : input_match matches '${form}' — a model-invocable skill, so the guard fails on a call it was never about`)
              evalBad++
            }
          }
        }
        guardNote = `; disabled-skills guard scoped to ${guardSkills} skill(s)`
      }
    } else {
      note(`eval suite: ${guardName} absent — the disabled-skills guard's scope is not checked (reported, not failed)`)
    }
    // One suite, one model: a partial FAMILY change must fail rather than grade two families under
    // one ledger (review 2026-09-14, medium). A release WITHIN the family moves every case at once
    // with no commit; the resolved ids each ledger row records catch that series break (spec 0014 §7).
    const distinctModels = [...new Set(models)].sort(compare)
    if (distinctModels.length > 1) {
      bad(`eval suite: cases pin DIFFERENT models (${distinctModels.join(', ')}) — one suite, one model: move every case's model: in the same commit so the ledger rows stay comparable (ADR 0076)`)
      evalBad++
    }
    if (cases.length === 0) {
      bad(`eval suite: ${evalDirName}/ exists but holds no <case>/prompt.md — an empty suite is not a pass (a case.yaml-only suite is out of this gate's scope; say so here if that is intended)`)
    } else if (evalBad === 0) {
      good(`eval suite: ${cases.length} case(s), ${graderCount} grader(s) — frontmatter keys, grader types and worker-model pins valid (model: ${distinctModels.join('/')})${guardNote}`)
    }
  }

  // --- canon ADR references (ADR 0095) ----------------------------------------------------------
  // The canon cites only its own decision records. Every ADR number in a tracked text file — a list
  // joined by `/`, `,`, `·`, `&`, `and`, `or` or a dash included, and the older hash form read as
  // zero-padded — must name a docs/adr/NNNN-*.md file: a consumer's ADR number resolves to nothing
  // here and to the WRONG record in any other consumer. Excluded: docs/adr/ (append-only history),
  // docs/handoff-archive/, and the generated docs surfaces. `git ls-files`, never a directory walk:
  // a walk would read gitignored eval results and local settings and fail on one machine only.
  // Canon shape only; every skip says why. The patterns are case-sensitive, as [regex]::Matches was.
  const adrRefRx = new RegExp(`(?<!${WB})ADRs?${S}+(0${D}{3}(?:${S}*(?:/|,|·|&|and|or|-|–|—)${S}*0${D}{3})*)(?!${WB})`, 'gu')
  const adrHashRx = new RegExp(`(?<!${WB})ADRs?${S}+#(${D}{1,4})(?!${WB})`, 'gu')
  const adrNumRx = new RegExp(`0${D}{3}`, 'gu')
  const adrRefExcludeRx = /^(docs\/adr\/|docs\/handoff-archive\/|docs\/(INDEX\.md|index\.json|docs\.html|docs\.artifact\.html|onboarding\.artifact\.html)$)/iu
  const adrDir = repoRoot ? join(repoRoot, 'docs/adr') : ''
  if (!inTree) {
    note('adr references: skipped — not the canon dogfood shape (only the canon has docs/adr to resolve against)')
  } else if (!isDir(adrDir)) {
    note('adr references: skipped — no docs/adr/ at the canon root, nothing to resolve against (reported, not silent)')
  } else if (!gitExe) {
    note('adr references: skipped — git not on PATH (reported, not silent)')
  } else if (!insideWorkTree()) {
    note('adr references: skipped — the canon shape is not inside a git work tree, so there is no tracked-file list (reported, not silent)')
  } else {
    const adrIds = new Set()
    for (const a of listDir(adrDir, 'file').filter(n => upper(ext(n)) === '.MD')) {
      const m = new RegExp(`^(${D}{4})-`, 'u').exec(a)
      if (m) adrIds.add(m[1])
    }
    const ls = gitRun(['-C', repoRoot, 'ls-files', '-z'])
    if (ls.status !== 0) {
      bad(`adr references: git ls-files exited ${ls.status ?? -1} — NOT CHECKED, not passed`)
    } else {
      let adrScanned = 0, adrRefs = 0, adrFiles = 0, adrBad = 0
      for (const rel of ls.text.split('\0').filter(Boolean)) {
        if (adrRefExcludeRx.test(rel)) continue
        const full = join(repoRoot, rel)
        if (!isFile(full)) continue                       // deleted in the work tree
        const bytes = fs.readFileSync(full)
        if (bytes.includes(0)) continue                   // binary
        adrScanned++
        const text = bytes.toString('utf8')
        if (!text.includes('ADR')) continue
        const lines = text.split('\n')
        let hitHere = false
        for (let i = 0; i < lines.length; i++) {
          // Both patterns start with the literal, case-sensitive `ADR`, so a line without it cannot
          // match either (ADR 0111).
          if (!lines[i].includes('ADR')) continue
          const nums = []
          for (const m of lines[i].matchAll(adrRefRx)) for (const n of m[1].matchAll(adrNumRx)) nums.push(n[0])
          for (const m of lines[i].matchAll(adrHashRx)) if (/^[0-9]+$/.test(m[1])) nums.push(String(parseInt(m[1], 10)).padStart(4, '0'))
          for (const num of nums) {
            adrRefs++; hitHere = true
            if (!adrIds.has(num)) {
              bad(`adr references: ${rel}:${i + 1} cites ADR ${num} — no docs/adr/${num}-*.md in this canon (a consumer's number? ADR 0095)`)
              adrBad++
            }
          }
        }
        if (hitHere) adrFiles++
      }
      if (adrBad === 0) {
        good(`adr references: ${adrRefs} reference(s) in ${adrFiles} of ${adrScanned} tracked text file(s) resolve to docs/adr (${adrIds.size} record(s))`)
      }
    }
  }

  // --- coverage report (visible every run, never a silent cap) --------------------------------
  // Nothing is excluded but the selftests themselves and ONE declared exclusion, skill template
  // payload (files under a `templates/` directory are content this plugin COPIES into a consuming
  // repo, not code it runs), counted separately rather than filtered in silence: an undeclared
  // narrowing is how a partial count comes to read as full coverage. Shipped and tested derive from
  // ONE enumeration so a new extension cannot land in one list while invisible to the other.
  const selftestRx = /\.selftest\.(ps1|mjs|js)$/iu
  const templateRx = /[\\/]templates[\\/]/iu
  const found = treeFiles.filter(f => inCi(ext(path.basename(f)), ['.ps1', '.mjs', '.js', '.sh', '.py']))
  const templatePayload = found.filter(f => templateRx.test(f))
  const all = found.filter(f => !templateRx.test(f))
  const shipped = all.filter(f => !selftestRx.test(path.basename(f)))
  const tested = new Set(all.filter(f => selftestRx.test(path.basename(f))).map(f => upper(path.basename(f).replace(selftestRx, ''))))
  const uncovered = shipped.map(f => path.basename(f)).filter(n => !tested.has(upper(n.replace(/\.(ps1|mjs|js|sh|py)$/iu, ''))))

  say('')
  say(`coverage: shipped=${shipped.length} with-selftest=${shipped.length - uncovered.length} uncovered=${uncovered.length} template-payload-excluded=${templatePayload.length}`)
  if (uncovered.length) {
    note(`  UNCOVERED (ships without a selftest in this plugin): ${uncovered.join(', ')}`)
    note('  Not a failure — declared so it stays visible rather than reading as full coverage.')
  }

  say('')
  if (fail.length) { say(`manifest-gate: FAILED (${fail.length})`, RED); process.exitCode = 1; return }
  say('manifest-gate: all checks passed', GREEN)
  process.exitCode = 0
}

try {
  await main()
} catch (e) {
  say(`manifest-gate: ABORTED — the gate itself threw, nothing was checked to the end: ${e && e.stack ? e.stack : e}`, RED)
  process.exitCode = 2
}
