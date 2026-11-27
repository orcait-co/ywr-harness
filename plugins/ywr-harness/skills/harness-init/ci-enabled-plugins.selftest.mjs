// Selftest for the vendored CI's "Fail on a committed enabledPlugins" step (ADR 0022), the CI half
// of the gate whose hook half is githooks.selftest.mjs B2 to B6. The step is an inline Node script
// inside templates/.github/workflows/harness-gates.yml, a toolchain payload whose placed copy is
// byte-identical to it (ADR 0014, manifest-gate). The properties of ADR 0022 are: both settings
// files, the key regardless of value, a \uXXXX-escaped spelling, "cannot parse" is "cannot verify"
// and never a pass, and tracked files only. B6 of the hook suite asserts that the hook does not
// catch the escaped key "because CI does", and C5 here is the half that makes that sentence true.
//
// The step's text is extracted from the template and executed in throwaway git repos, so what runs
// is what ships. A renamed step or a moved heredoc fails this suite loudly instead of testing nothing.
//
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/harness-init/ci-enabled-plugins.selftest.mjs
//
// The parity check of ADR 0227 decision 8 matches test names, so `WS canon shape`, `WS canon workflows`
// and `CX` keep their names after the ID. The line readers match case-insensitively, except the
// SHA pin of WS2.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixtureRoot, removeFixtureRoot, toRx, innerJobs } from '../../lib/selftest-lib.mjs'
import { git_run, git_absent, which_on_path, GIT_PINS } from './templates/scripts/harness/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const yml = path.join(here, 'templates/.github/workflows/harness-gates.yml')
const M = (text, pat) => toRx(pat).test(text)

if (!fs.existsSync(yml) || !fs.statSync(yml).isFile()) {
  test('WS0e the workflow template is present', () => { assert.fail(`FAIL — workflow template missing: ${yml}`) })
}
// LF, CRLF and CR end a line, and a final line end adds no empty line.
function readAllLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}
const lazy = (fn) => { let done = false; let v; return () => { if (!done) { v = fn(); done = true } return v } }

// --- WS: static classes over the workflow text (ADR 0087) -----------------------------------------
// Two finding classes, made deterministic so that they cost no review tokens:
// (1) a `${{ }}` expression spliced into `run:` text, the shell-injection surface that the template's
// own rule closes (values reach a script through `env:` only);
// (2) a `uses:` that is not a full 40-hex commit SHA with its `# vX.Y.Z` comment (ADR 0087).
// They need neither git nor node, so they run ahead of the git-dependent cases below, and a
// missing git skips only those.
// Scope: the shipped template, plus the canon's own .github/workflows when this plugin sits in the
// canon dogfood shape (plugins/ywr-harness under a root that holds both .harness.json and
// .claude-plugin/marketplace.json, the manifest gate's test). A marketplace cache, the dist and the
// Linux parity container have no canon workflows, and that is reported.
// The guarantee: WS1 and WS2 are line readers of `run:` and `uses:` written as plain block keys, and
// WS3 refuses every other YAML spelling of a key or value. So it holds for a workflow in the shape
// that WS3 enforces, not for any YAML that GitHub accepts. No YAML parser runs.
function getRunExpressionHits(lines) {
  // A `run:` value is its key line plus every following line indented deeper than the key, blank
  // lines included, in any scalar style: a `|` or `>` block, a plain scalar continued on the next
  // lines, or a quoted scalar spanning lines. YAML puts every continuation line of a block-mapping
  // value deeper than its key, so one rule reads them all.
  // A double-quoted value holding a backslash is a hit on its own: its escapes (`\x24`, a 4-hex `\u`
  // escape of `$`, an escaped line break joining `$` to `{{`) spell `${{` without the literal text a
  // line reader looks for. `env:`, `if:` and `with:` values are the sanctioned place for an
  // expression and are never scanned.
  const hits = []
  let blocks = 0
  let keyCol = -1
  let dq = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (keyCol >= 0) {
      if (l.trim().length === 0) continue
      if ((l.length - l.trimStart().length) > keyCol) {
        if (l.includes('${{') || (dq && l.includes('\\'))) hits.push(`line ${i + 1}: ${l.trim()}`)
        continue
      }
      keyCol = -1
    }
    const m = /^(\s*)(-\s+)?run:(\s+(.*))?$/i.exec(l)
    if (m) {
      const col = m[1].length + (m[2] ? m[2].length : 0)
      const val = m[4] ?? ''
      blocks++
      keyCol = col
      dq = val.startsWith('"')
      if (!/^[|>][-+0-9]*\s*(#.*)?$/i.test(val) && (val.includes('${{') || (dq && val.includes('\\')))) {
        hits.push(`line ${i + 1}: ${l.trim()}`)
      }
    }
  }
  return { hits, blocks }
}
function getShapeHits(lines) {
  // The shape rule that the guarantee of WS1 and WS2 rests on. Outside a scalar's own text (a block
  // body or a multi-line continuation deeper than its key, as getRunExpressionHits reads it) and
  // comment lines, every line is a plain `key:` line or a `- item` line, and no value opens a flow
  // mapping, an anchor, an alias, a tag or an explicit key. Each refused construct is a spelling
  // that GitHub accepts and the line readers cannot see: `- { uses: a/b@v1 }`, `steps: [ {run: …} ]`,
  // a quoted, tagged or spaced key (`"run":`, `!!str run:`, `uses :`), `? run`, `run: *script` with
  // `&script` under another key, and `<<: *defaults`. The allowed flow forms hold no key: an empty
  // flow mapping (`permissions: {}`) and a flow sequence of plain scalars closed on its line
  // (`branches: [main, master]`).
  const hits = []
  let bodyCol = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const ind = l.length - l.trimStart().length
    if (bodyCol >= 0) {
      if (l.trim().length === 0 || ind > bodyCol) continue
      bodyCol = -1
    }
    const t = l.trim()
    if (t.length === 0 || t.startsWith('#') || t === '-') continue
    let why = null
    let key, col, v, isItem
    let m = /^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_-]*):(\s+(.*))?$/i.exec(l)
    if (m) {
      key = m[3]
      col = m[1].length + (m[2] ? m[2].length : 0)
      v = (m[5] ?? '').trim()
      if (v.startsWith('#')) v = ''
      isItem = false
    } else if ((m = /^(\s*)-\s+(.*)$/i.exec(l))) {
      key = null; col = m[1].length; v = m[2].trim(); isItem = true
    } else {
      hits.push(`line ${i + 1}: not a plain key or item line: ${t}`); continue
    }
    if (v.length === 0) {
      // A nested block follows, except under run:, whose value is always a string, so the deeper
      // lines are its plain multi-line text.
      if (key !== null && key.toLowerCase() === 'run') bodyCol = col
      continue
    }
    const c0 = v[0]
    if (/^\{\s*\}\s*(#.*)?$/i.test(v)) { /* `permissions: {}`: an empty flow mapping holds no key */ }
    else if ('{&*!?@`%'.indexOf(c0) >= 0) why = `value opens a flow mapping, anchor, alias, tag or reserved indicator ('${c0}')`
    else if (c0 === '[') {
      const fm = /^\[([^[\]{}:]*)\]\s*(#.*)?$/i.exec(v)
      if (!fm || /(^|,)\s*[&*!]/i.test(fm[1])) why = 'a flow sequence that is not plain scalars closed on this line'
    }
    else if (isItem && /^-(\s|$)/i.test(v)) why = 'a nested sequence in compact form'
    else if (isItem && /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/i.test(v)) why = 'a quoted key'
    else if (isItem && c0 !== '"' && c0 !== "'" && /:(\s|$)/i.test(v.replace(/\s+#.*$/, ''))) why = 'a key that is not a plain `name:`'
    if (why) { hits.push(`line ${i + 1}: ${why}: ${t}`); continue }
    // A scalar value: a deeper line that follows is its continuation, text and not structure.
    bodyCol = col
  }
  return { hits }
}
function getUsesPinHits(lines) {
  // Case-sensitive (no i flag): a SHA is lowercase hex, and git never prints an uppercase spelling.
  const hits = []
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(-\s+)?uses:/i.test(lines[i])) continue
    count++
    if (!/^\s*(- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(lines[i])) {
      hits.push(`line ${i + 1}: ${lines[i].trim()}`)
    }
  }
  return { hits, count }
}
function getWorkflowVerdict(lines, isTemplate) {
  // The vacuity halves bind the template only: its run: blocks and uses: steps are the point, so a
  // reader that finds none there is broken. A canon workflow made only of uses: steps has no run:
  // text to inject into, and one with no uses: has nothing to pin. Each passes on the property itself.
  const rx = getRunExpressionHits(lines)
  const ux = getUsesPinHits(lines)
  const sx = getShapeHits(lines)
  return {
    run: rx, uses: ux, shape: sx,
    WS1: rx.hits.length === 0 && (!isTemplate || rx.blocks > 0),
    WS2: ux.hits.length === 0 && (!isTemplate || ux.count > 0),
    WS3: sx.hits.length === 0,
  }
}
const hitLines = (hits) => hits.map((h) => h.split(':')[0]).join(',')

// WS0: the detectors themselves, on synthetic text, so a detector that finds nothing cannot make
// the per-file cases below pass vacuously. Hits are asserted by line, not only by count.
// The fixture text holds `${{` on purpose, so these are plain quoted strings, never template literals.
const synthRun = [
  'jobs:',
  '  j:',
  '    steps:',
  '      - name: a',
  '        env:',
  '          X: ${{ github.base_ref }}',
  '        run: |',
  '          echo "$X"',
  '          echo "${{ github.base_ref }}"',
  '      - run: echo ${{ github.event.before }}',
  '      - name: b',
  "        if: ${{ github.event_name == 'push' }}",
  '        run: >-',
  '          echo ok',
  '',
  '          echo ${{ x }}',
  '      - name: c',
  '        with:',
  '          k: ${{ y }}',
]
test('WS0 the run: detector flags a block line, an inline run and a folded block — and no env:/if:/with: value', () => {
  const sr = getRunExpressionHits(synthRun)
  const srLines = hitLines(sr.hits)
  assert.ok(sr.blocks === 3 && srLines === 'line 9,line 10,line 16', `blocks=${sr.blocks} hits=${sr.hits.join(' | ')}`)
})
const synthUses = [
  '        uses: actions/checkout@v5',
  '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
  '      - uses: a/b@FBC6F3992D24B796D5A048FF273F7FCC4A7B6C09 # v5.1.0',
  '        uses: a/b@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  '        uses: a/b/sub@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v1.2.3',
  '        # uses: a/b@v1',
]
test('WS0 the uses: detector flags a tag, an uppercase SHA and a missing comment — not a pin, a sub-path pin or a comment', () => {
  const su = getUsesPinHits(synthUses)
  const suLines = hitLines(su.hits)
  assert.ok(su.count === 5 && suLines === 'line 1,line 3,line 4', `count=${su.count} hits=${su.hits.join(' | ')}`)
})
// WS0b: every multi-line scalar style under run: is read, namely a plain value after an empty value,
// a quoted scalar spanning lines and a plain value continued, plus a double-quoted escape that spells `${{`.
// A single-quoted value (no escapes in YAML) and an env: value stay clean.
const synthRunMulti = [
  'jobs:',
  '  j:',
  '    steps:',
  '      - name: d',
  '        run:',
  '          echo ${{ github.head_ref }}',
  '      - name: e',
  '        run: "echo ok',
  '          ${{ github.head_ref }}"',
  '      - name: f',
  '        run: echo a',
  '          ${{ x }}',
  '      - name: g',
  '        run: "echo \\x24{{ github.head_ref }}"',
  '      - name: h',
  "        run: 'echo it''s fine'",
  '        env:',
  '          Y: ${{ z }}',
]
test('WS0b the run: detector reads plain, quoted and continued multi-line values and a double-quoted escape — not a single-quoted value or env:', () => {
  const srm = getRunExpressionHits(synthRunMulti)
  const srmLines = hitLines(srm.hits)
  assert.ok(srm.blocks === 5 && srmLines === 'line 6,line 9,line 12,line 14', `blocks=${srm.blocks} hits=${srm.hits.join(' | ')}`)
})
// WS0c: the shape rule. Every accepted form the canon files use passes, and each spelling the line
// readers cannot see is refused by line. Lines 4 and 5 are the flow-mapping steps that the uses:
// reader does not even count.
const synthShapeOk = [
  'name: ok',
  'on:',
  '  push:',
  '    branches: [main, master]',
  '    paths:',
  '      - "docs/**"',
  "      - 'plugins/**'",
  'permissions: {}',
  'jobs:',
  '  j:',
  '    runs-on: ubuntu-latest',
  '    strategy:',
  '      matrix:',
  '        shard: ["1/4", "2/4"]',
  '    steps:',
  '      # a comment { with * & ! }',
  '      - name: Checkout',
  '        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
  '      - name: a',
  "        if: github.event_name == 'push'",
  '        run: |',
  '          { echo "x: y"; } && echo *',
  '          - not an item',
  '      - run:',
  '          echo plain multi-line',
  '      -',
  '        name: bare dash',
  '        run: echo "k: v" # trailing',
]
test('WS0c the shape rule accepts every form the canon workflows use (flow scalar lists, quoted items, block and multi-line run: text)', () => {
  const ssOk = getShapeHits(synthShapeOk)
  assert.ok(ssOk.hits.length === 0, `hits=${ssOk.hits.join(' | ')}`)
})
const synthShapeBad = [
  'jobs:',
  '  j:',
  '    steps:',
  '      - { uses: actions/checkout@v5 }',
  '      - {name: x, uses: a/b@main}',
  '      - name: q',
  '        "run": echo ${{ x }}',
  '      - "uses": a/b@v1',
  '      - name: s',
  '        uses : a/b@v1',
  '        run: *script',
  '        x-script: &script echo ${{ x }}',
  '        <<: *defaults',
  '        ? run',
  '        : echo ${{ x }}',
  '        !!str run: echo',
  '    other: [ {run: echo x} ]',
  '    more: [uses: a/b@v1]',
]
test('WS0c the shape rule refuses flow-mapping steps, quoted/spaced/tagged/explicit keys, anchors, aliases, merge keys and flow pairs — by line', () => {
  const ssBad = getShapeHits(synthShapeBad)
  const ssBadLines = hitLines(ssBad.hits)
  assert.ok(ssBadLines === 'line 4,line 5,line 7,line 8,line 10,line 11,line 12,line 13,line 14,line 15,line 16,line 17,line 18', `hits=${ssBad.hits.join(' | ')}`)
})
test('WS0c control: the uses: line reader alone counts none of those four uses: spellings (why the shape rule exists)', () => {
  const suFlow = getUsesPinHits(synthShapeBad)
  assert.ok(suFlow.count === 0, `count=${suFlow.count} hits=${suFlow.hits.join(' | ')}`)
})
// WS0d: the vacuity halves bind the template only. A uses-only canon workflow passes WS1 and a
// run-only one passes WS2, and the same texts as the template fail them.
const usesOnly = [
  'name: labeler',
  'on: [pull_request]',
  'jobs:',
  '  l:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
]
const runOnly = ['jobs:', '  r:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo ok']
test('WS0d a uses-only canon workflow passes WS1, a run-only one passes WS2 — nothing to inject into or to pin is not a defect', () => {
  const vU = getWorkflowVerdict(usesOnly, false)
  const vR = getWorkflowVerdict(runOnly, false)
  assert.ok(vU.WS1 && vU.WS2 && vU.WS3 && vR.WS1 && vR.WS2 && vR.WS3,
    `usesOnly WS1=${vU.WS1} WS2=${vU.WS2} WS3=${vU.WS3}; runOnly WS1=${vR.WS1} WS2=${vR.WS2} WS3=${vR.WS3}`)
})
test('WS0d control: as the TEMPLATE, the same texts fail the vacuity halves (a reader that finds nothing there is broken)', () => {
  const vUt = getWorkflowVerdict(usesOnly, true)
  const vRt = getWorkflowVerdict(runOnly, true)
  assert.ok(!vUt.WS1 && vUt.WS2 && vRt.WS1 && !vRt.WS2,
    `usesOnly-as-template WS1=${vUt.WS1} WS2=${vUt.WS2}; runOnly-as-template WS1=${vRt.WS1} WS2=${vRt.WS2}`)
})

const wfFiles = [yml]
// Each step runs only after the previous one held. In the Linux parity container the plugin root is
// the mount (`/repo`), whose grandparent does not exist, so an eager parent chain would throw.
const pluginRoot = path.resolve(here, '../..')
const pluginsDir = path.dirname(pluginRoot)
const canonRoot = pluginsDir !== pluginRoot ? path.dirname(pluginsDir) : ''
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const leaf = (p) => path.basename(p).toLowerCase()
const isCanon = leaf(pluginRoot) === 'ywr-harness' && !!pluginsDir && leaf(pluginsDir) === 'plugins' && !!canonRoot &&
  isFile(path.join(canonRoot, '.harness.json')) && isFile(path.join(canonRoot, '.claude-plugin/marketplace.json'))
if (isCanon) {
  const canonWf = path.join(canonRoot, '.github/workflows')
  let names = []
  try { names = fs.readdirSync(canonWf, { withFileTypes: true }).filter((e) => e.isFile() && ['.yml', '.yaml'].includes(path.extname(e.name).toLowerCase())).map((e) => e.name) } catch { /* no folder: the case below fails */ }
  names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
  const canonFiles = names.map((n) => path.join(canonWf, n))
  test('WSC1 WS canon shape: .github/workflows holds workflows to scan (an empty scan is not a pass)', () => {
    assert.ok(canonFiles.length > 0, `no *.yml under ${canonWf}`)
  })
  wfFiles.push(...canonFiles)
} else {
  test('WSC2 WS canon workflows', { skip: 'not the canon dogfood shape — template only (reported, not silent)' }, () => {})
}
if (fs.existsSync(yml)) {
  for (const wf of wfFiles) {
    const wfLines = readAllLines(wf)
    const label = wf === yml ? 'template harness-gates.yml' : `.github/workflows/${path.basename(wf)}`
    const v = getWorkflowVerdict(wfLines, wf === yml)
    test(`WS1 no \${{ }} expression inside a run: value — ${label} (${v.run.blocks} run: key(s))`, () => {
      assert.ok(v.WS1, `blocks=${v.run.blocks}; pass values through env: — ${v.run.hits.join(' | ')}`)
    })
    test(`WS2 every uses: is a 40-hex SHA pin with a # vX.Y.Z comment — ${label} (${v.uses.count} uses:)`, () => {
      assert.ok(v.WS2, `count=${v.uses.count}; ADR 0087 — ${v.uses.hits.join(' | ')}`)
    })
    test(`WS3 the workflow is in the shape WS1/WS2 read (plain block keys; no flow mapping, anchor, alias, tag or non-plain key) — ${label}`, () => {
      assert.ok(v.WS3, `rewrite in plain block form — ${v.shape.hits.join(' | ')}`)
    })
  }
}

const noGit = git_absent()
const skipGit = noGit ? 'git absent (reported, not silent) — CI has git' : false

// --- extract the step's Node script from the template -------------------------------------------
// The anchors are the step name, then the heredoc opener inside that step, then the closing `JS`.
// The heredoc body shares the opener's indent, and the extraction strips it so the text runs as a file.
// Every anchor is asserted, so an empty or missing extraction fails and never passes vacuously.
const STEP_NAME = 'Fail on a committed enabledPlugins'
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)
const extractStep = lazy(() => {
  const lines = readAllLines(yml)
  const nameRx = new RegExp(`^\\s*-\\s+name:\\s+${escRx(STEP_NAME)}\\s*$`, 'i')
  let iName = -1
  for (let i = 0; i < lines.length; i++) if (nameRx.test(lines[i])) { iName = i; break }
  if (iName < 0) throw new Error(`FAIL — step '${STEP_NAME}' not found in ${yml} (renamed? this suite tests it by name)`)
  let iOpen = -1
  let indent = 0
  for (let i = iName + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:/i.test(lines[i])) break                      // the next step: this step has no heredoc
    const m = /^(\s*)"\$HARNESS_NODE"\s+--input-type=module\s+-\s+<<'JS'\s*$/i.exec(lines[i])
    if (m) { iOpen = i; indent = m[1].length; break }
  }
  if (iOpen < 0) throw new Error(`FAIL — no "$HARNESS_NODE" --input-type=module - <<'JS' heredoc inside step '${STEP_NAME}'`)
  const body = []
  let closed = false
  for (let i = iOpen + 1; i < lines.length; i++) {
    if (lines[i].trim() === 'JS') { closed = true; break }
    const l = lines[i]
    if (l.trim().length === 0) { body.push(''); continue }
    if (l.length < indent || l.slice(0, indent).trim().length !== 0) {
      // A non-blank body line indented less than the opener is not a heredoc body line that YAML
      // hands to node as written, so the extraction window is corrupt. The error names it instead
      // of surfacing as a SyntaxError from the child.
      throw new Error(`FAIL — line ${i + 1} of the heredoc is indented less than its opener; extraction window corrupt: ${l}`)
    }
    body.push(l.slice(indent))
  }
  if (!closed || body.length === 0) throw new Error(`FAIL — heredoc in step '${STEP_NAME}' has no closing JS or an empty body`)
  const stepText = body.join('\n') + '\n'
  for (const must of ['JSON.parse', 'git_paths', 'ls-files', 'enabledPlugins']) {
    if (!stepText.toLowerCase().includes(must.toLowerCase())) {
      throw new Error(`FAIL — extracted step text lacks '${must}'; the extraction window is wrong, not the step`)
    }
  }
  return stepText
})
test('EX1 the step text of "Fail on a committed enabledPlugins" extracts from the template', { skip: skipGit }, () => { extractStep() })

const fxBase = fixtureRoot('ci-enabled-plugins-selftest')
after(() => removeFixtureRoot(fxBase))
const stepFile = path.join(fxBase, 'enabled_plugins_step.mjs')
const gitBoundary = path.join(here, 'templates/scripts/harness/harness_git.mjs')   // the step imports it from the repo it runs in
const stepReady = lazy(() => { fs.writeFileSync(stepFile, extractStep(), 'utf8'); return stepFile })

// --- fixtures ------------------------------------------------------------------------------------
// Every scenario is one async chain that starts when the file loads, and every child start goes
// through one slot pool of the machine's CPU count (at most 8). The scenarios share nothing, so the
// cases only await theirs. The seed repository (init, identity, an empty seed commit and the placed
// git boundary) is built once, and each scenario gets a copy. A copied .git folder is a real repository.
const POOL = innerJobs(8, 2)
let poolActive = 0
const poolWait = []
async function slotted(fn) {
  if (poolActive >= POOL) await new Promise((resolve) => poolWait.push(resolve))   // the releaser hands its slot over
  else poolActive++
  try { return await fn() } finally { const next = poolWait.shift(); if (next) next(); else poolActive-- }
}
function spawnA(file, args, { cwd, env } = {}) {
  return slotted(() => new Promise((resolve, reject) => {
    const c = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const so = []; const se = []
    c.stdout.on('data', (d) => so.push(d))
    c.stderr.on('data', (d) => se.push(d))
    c.on('error', reject)
    c.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(so).toString('utf8'), stderr: Buffer.concat(se).toString('utf8') }))
  }))
}
// The git boundary's pins, on the git that PATH resolves. A fixture git call that fails throws.
const gitExe = which_on_path('git')
async function gitA(repo, args) {
  const x = await spawnA(gitExe, [...GIT_PINS, ...args], { cwd: repo, env: process.env })
  if (x.code !== 0) throw new Error(`git ${args.join(' ')} exited ${x.code} in ${repo}: ${x.stderr}`)
  return x.stdout
}
let seedRepo = null
function newRepo(name) {
  if (!seedRepo) {
    seedRepo = path.join(fxBase, '_seed')
    fs.mkdirSync(seedRepo, { recursive: true })
    git_run(seedRepo, ['init', '-q'])
    git_run(seedRepo, ['config', 'user.email', 'selftest@example.invalid'])
    git_run(seedRepo, ['config', 'user.name', 'selftest'])
    git_run(seedRepo, ['commit', '-q', '--allow-empty', '-m', 'seed'])
    // The placed scaffold carries the git boundary, and the step imports it from the working directory.
    fs.mkdirSync(path.join(seedRepo, 'scripts/harness'), { recursive: true })
    fs.copyFileSync(gitBoundary, path.join(seedRepo, 'scripts/harness/harness_git.mjs'))
  }
  const p = path.join(fxBase, name)
  fs.cpSync(seedRepo, p, { recursive: true })
  return p
}
function writeUntracked(repo, rel, body) {
  const full = path.join(repo, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body.replace(/\r\n/g, '\n'), 'utf8')
}
async function writeTracked(repo, rel, body) {
  writeUntracked(repo, rel, body)
  // -f: a global gitignore can exclude .claude/settings.local.json (ADR 0021). Without -f, `add`
  // would stage nothing there, and C3 would pass vacuously on that machine. Same as githooks B4.
  await gitA(repo, ['add', '-f', '--', rel])
  await gitA(repo, ['commit', '-q', '-m', `add ${rel}`])
}
async function invokeStep(repo) {
  // The step prints Korean. Node writes UTF-8 to a pipe whatever the console codepage is, so nothing
  // is pinned here, and the suite runs the step in the environment that the vendored workflow gives it.
  const x = await spawnA(process.execPath, [stepReady()], { cwd: repo, env: process.env })
  return { out: x.stdout + x.stderr, code: x.code }
}
// One repo, built and run once, read by every case of its ID. It starts at once unless git is absent.
const scenario = (name, build) => {
  if (skipGit) return () => Promise.reject(new Error(String(skipGit)))
  const p = Promise.resolve().then(async () => { const repo = newRepo(name); await build(repo); return { repo, r: await invokeStep(repo) } })
  p.catch(() => {})   // A failure surfaces in the cases that await it, not as an unhandled rejection.
  return () => p
}
const gcase = (name, fn) => test(name, { skip: skipGit }, fn)
const detail = (r) => `exit=${r.code} out=${r.out}`

// --- CX: the shipped text keeps its git read behind the boundary (spec 0007 §4) ---------------------
// The step's `ls-files` read parses paths. TARGETS is a closed ASCII set, so the encoding pin that
// harness_git.mjs applies is dormant. This case keeps a wider list from routing the read around the boundary.
gcase("CX1 CX the step's git read goes through the harness git boundary (harness_git.mjs owns the pins), never a spawn of its own", async () => {
  const stepText = extractStep()
  assert.ok(M(stepText, String.raw`git_paths\(process\.cwd\(\), \['ls-files'`) && M(stepText, String.raw`scripts/harness/harness_git\.mjs`) && !M(stepText, 'child_process'),
    'the git ls-files read does not use git_paths from harness_git.mjs, or the step spawns a process itself')
})

const SETTINGS = '.claude/settings.json'
const LOCAL = '.claude/settings.local.json'
const CLEAN_BODY = '{ "permissions": { "allow": ["Bash(git *)"] }, "hooks": {} }'
const ENABLED = '{ "enabledPlugins": { "ywr-harness@ywrlabs": true } }'

// --- C0: no target file at all passes, and the count says zero were checked ----------------------
const c0 = scenario('c0-none', () => {})
gcase('C0 a repo without either settings file passes', async () => { const { r } = (await c0()); assert.ok(r.code === 0, detail(r)) })
gcase('C0 the pass line counts zero targets (never a silent pass)', async () => { const { r } = (await c0()); assert.ok(M(r.out, 'OK') && M(r.out, '0개'), r.out) })

// --- C1: the control, a tracked settings.json without the key passes ------------------------------
// Without this, a step that refused .claude/settings.json unconditionally would pass C2, C4 and C5.
const c1 = scenario('c1-clean', async (repo) => await writeTracked(repo, SETTINGS, CLEAN_BODY))
gcase('C1 a shared settings file without the key passes', async () => { const { r } = (await c1()); assert.ok(r.code === 0, detail(r)) })
gcase('C1 the file was counted (1 target checked)', async () => { const { r } = (await c1()); assert.ok(M(r.out, '1개'), r.out) })
gcase('C1 nothing is reported as an error', async () => { const { r } = (await c1()); assert.ok(!M(r.out, '::error::'), r.out) })

// --- C2: --scope project's write target is refused, with the forcing consequence and the ADRs -----
const c2 = scenario('c2-project', async (repo) => await writeTracked(repo, SETTINGS, ENABLED))
gcase('C2 a committed enabledPlugins in settings.json FAILS the step', async () => { const { r } = (await c2()); assert.ok(r.code === 1, detail(r)) })
gcase('C2 the error is a GitHub annotation naming the file', async () => { const { r } = (await c2()); assert.ok(M(r.out, String.raw`::error::\.claude/settings\.json`), r.out) })
gcase('C2 the governing ADRs are named', async () => { const { r } = (await c2()); assert.ok(M(r.out, 'ADR 0010/0022'), r.out) })
gcase('C2 the remedy says rescoping is NOT a fix (ADR 0021 routed members into the unchecked file)', async () => {
  const { r } = (await c2()); assert.ok(M(r.out, '--scope local') && M(r.out, '해결이 아닙니다'), r.out)
})

// --- C3: --scope local's write target is gated too (ADR 0022) ------------------------------------
const c3 = scenario('c3-local', async (repo) => await writeTracked(repo, LOCAL, ENABLED))
gcase('C3 a committed settings.local.json with the key FAILS the step', async () => { const { r } = (await c3()); assert.ok(r.code === 1, detail(r)) })
gcase('C3 the annotation names the LOCAL file', async () => { const { r } = (await c3()); assert.ok(M(r.out, String.raw`::error::\.claude/settings\.local\.json`), r.out) })

// --- C4: the key is refused regardless of value, an uninstall's `{}` residue included ------------
const c4 = scenario('c4-inert', async (repo) => await writeTracked(repo, SETTINGS, '{ "enabledPlugins": {} }'))
gcase('C4 an inert empty enabledPlugins is refused too (key, not value)', async () => { const { r } = (await c4()); assert.ok(r.code === 1, detail(r)) })
const c4b = scenario('c4b-false', async (repo) => await writeTracked(repo, SETTINGS, '{ "enabledPlugins": { "ywr-harness@ywrlabs": false } }'))
gcase('C4b an all-false map is refused too', async () => { const { r } = (await c4b()); assert.ok(r.code === 1, detail(r)) })

// --- C5: a \uXXXX-escaped key is the same key to a JSON parser, and CI catches what the hook cannot --
// The fixture is built without the escape sequence appearing literally in this source, because a
// text pass that decodes it would turn the case into a plain-key duplicate of C2 that still goes
// green. The case asserts that the raw bytes lack the plain spelling before the step runs, so it
// cannot pass vacuously.
const c5 = scenario('c5-escaped', async (repo) => {
  const escapedKey = '"' + String.fromCharCode(92) + 'u0065nabledPlugins"'
  await writeTracked(repo, SETTINGS, '{ ' + escapedKey + ': { "ywr-harness@ywrlabs": true } }')
})
gcase('C5 fixture holds the ESCAPED spelling, not the plain key (case is not vacuous)', async () => {
  const { repo } = (await c5())
  const raw = fs.readFileSync(path.join(repo, SETTINGS), 'utf8')
  assert.ok(!M(raw, '"enabledPlugins"') && M(raw, 'u0065nabledPlugins'), raw)
})
gcase("C5 the escaped key is refused (the hook's known limit, B6, is closed here)", async () => { const { r } = (await c5()); assert.ok(r.code === 1, detail(r)) })
gcase('C5 the annotation names the file', async () => { const { r } = (await c5()); assert.ok(M(r.out, String.raw`::error::\.claude/settings\.json`), r.out) })

// --- C6: a file that does not parse is "cannot verify", never a pass -----------------------------
const c6 = scenario('c6-unparseable', async (repo) => await writeTracked(repo, SETTINGS, '{ "enabledPlugins": '))
gcase('C6 an unparseable target FAILS the step', async () => { const { r } = (await c6()); assert.ok(r.code === 1, detail(r)) })
gcase('C6 the failure says it could not verify, not that it found the key', async () => {
  const { r } = (await c6()); assert.ok(M(r.out, '파싱할 수 없어') && !M(r.out, '선언합니다'), r.out)
})
// The same shape with no key in the truncated text. A parse failure alone must fail, or the "cannot
// verify" rule would really be "found it by substring".
const c6b = scenario('c6b-unparseable-nokey', async (repo) => await writeTracked(repo, SETTINGS, '{ "permissions": '))
gcase('C6b an unparseable target without the key still FAILS (verify, not grep)', async () => {
  const { r } = (await c6b()); assert.ok(r.code === 1 && M(r.out, '파싱할 수 없어'), detail(r))
})
// C6c: bytes that are not UTF-8 at all. A decode error is the same "cannot verify" class as a parse
// error, and it is a named refusal, not a traceback.
const c6c = scenario('c6c-not-utf8', async (repo) => {
  const p = path.join(repo, SETTINGS)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))
  await gitA(repo, ['add', '-f', '--', SETTINGS])
  await gitA(repo, ['commit', '-q', '-m', 'add not-utf8'])
})
gcase('C6c a non-UTF-8 target is "cannot verify" (exit 1, named), not a traceback', async () => {
  const { r } = (await c6c()); assert.ok(r.code === 1 && M(r.out, '파싱할 수 없어') && !M(r.out, 'Traceback'), detail(r))
})

// --- C7: tracked files only, an untracked local install is the allowed state -------------------
// `claude plugin install --scope local` writes the key into the work tree. The rule is that the key
// never reaches git, not that it never exists. A step reading the work tree would fail every member
// who installed the plugin the sanctioned way.
const c7 = scenario('c7-untracked', async (repo) => { await writeTracked(repo, SETTINGS, CLEAN_BODY); writeUntracked(repo, LOCAL, ENABLED) })
gcase('C7 an UNTRACKED settings.local.json with the key does not fail the step', async () => { const { r } = (await c7()); assert.ok(r.code === 0, detail(r)) })
gcase('C7 only the tracked file was counted', async () => { const { r } = (await c7()); assert.ok(M(r.out, '1개'), r.out) })

// --- C8: odd but valid JSON shapes are handled, not crashed on --------------------------------
// A top-level list has no keys. A nested enabledPlugins is inert data, because the host reads the
// key at the top level only, and a substring check would refuse it.
const c8 = scenario('c8-list', async (repo) => await writeTracked(repo, SETTINGS, '[ "not", "an", "object" ]'))
gcase('C8 a top-level JSON list passes without a traceback', async () => { const { r } = (await c8()); assert.ok(r.code === 0 && !M(r.out, 'Traceback'), detail(r)) })
const c8b = scenario('c8b-nested', async (repo) => await writeTracked(repo, SETTINGS, '{ "note": { "enabledPlugins": { "x@y": true } } }'))
gcase('C8b a nested enabledPlugins is not the host key — passes (top-level rule, not a substring)', async () => { const { r } = (await c8b()); assert.ok(r.code === 0, detail(r)) })

// --- C9 to C11: every offending file is named in one run, across violation classes -------------
// C9: both declare the key. C10: one declares the key and the other fails to parse. The step must
// not exit on the first parse failure and lose the violation it already found. C11: both fail to
// parse. `git ls-files` lists settings.json before settings.local.json, so C10's parse failure is
// the later file, the order that would lose the report.
const c9 = scenario('c9-both', async (repo) => { await writeTracked(repo, SETTINGS, '{ "enabledPlugins": {} }'); await writeTracked(repo, LOCAL, '{ "enabledPlugins": {} }') })
gcase('C9 both offending files are named in one run', async () => {
  const { r } = (await c9())
  assert.ok(r.code === 1 && M(r.out, String.raw`::error::\.claude/settings\.json`) && M(r.out, String.raw`::error::\.claude/settings\.local\.json`), detail(r))
})
const c10 = scenario('c10-key-then-unparseable', async (repo) => { await writeTracked(repo, SETTINGS, '{ "enabledPlugins": {} }'); await writeTracked(repo, LOCAL, '{ "enabledPlugins": ') })
gcase('C10 a key violation is still reported when a LATER file fails to parse', async () => {
  const { r } = (await c10())
  assert.ok(r.code === 1 && M(r.out, String.raw`::error::\.claude/settings\.json 이 enabledPlugins`) && M(r.out, String.raw`::error::\.claude/settings\.local\.json 를 파싱할 수 없어`), detail(r))
})
gcase('C10 the remedy lines accompany the key violation', async () => { const { r } = (await c10()); assert.ok(M(r.out, '해결이 아닙니다'), r.out) })
const c11 = scenario('c11-both-unparseable', async (repo) => { await writeTracked(repo, SETTINGS, '{ "a": '); await writeTracked(repo, LOCAL, '[ 1, ') })
gcase('C11 both unparseable files are named, not only the first', async () => {
  const { r } = (await c11())
  assert.ok(r.code === 1 && M(r.out, String.raw`::error::\.claude/settings\.json 를 파싱할 수 없어`) && M(r.out, String.raw`::error::\.claude/settings\.local\.json 를 파싱할 수 없어`), detail(r))
})
