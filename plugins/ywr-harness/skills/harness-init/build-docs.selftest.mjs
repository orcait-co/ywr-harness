// Selftest for templates/docs/build_docs.mjs: the duplicate-id refusal and the fm_digest staleness
// stamp (ADR 0043), including the pairing with the recomputation in scripts/verify_map.mjs.
// Usage: node --test-reporter=<file URL of ../../lib/selftest-reporter.mjs> --test-reporter-destination=stdout skills/harness-init/build-docs.selftest.mjs
//
// The suite runs the template copy, a payload that this plugin ships. The manifest-gate dogfood
// placement sweep enforces its byte identity with the canon's docs/build_docs.mjs. The copy sits in
// a fixture docs tree at <fixture>/docs/build_docs.mjs, because the builder resolves its corpus
// relative to its own file. The first sections need no git: verify_map runs with --repo and
// explicit files, which skips scope resolution.
//
// Two cases are subtle. D asserts that a body-only edit does not flip the digest, the cry-wolf
// rule that the retro's BUILD check shares (its D2 case). The lead-HTML-comment document in the base
// corpus pins that both digest implementations skip the comment identically. E is the pairing case:
// build with one implementation, check with the other, and drift on either side fails it.
//
// The suite mutates one fixture tree in a fixed order, and most cases read the state that the cases
// before them left (ADR 0227). Each check awaits its own test(), so a state change between two checks
// runs after the first check reported and before the second is computed. A case ID is the first
// token of a test name. The bare-letter groups (A to H, FL, BW) carry a number after the letter, and
// the parity script matches the names that follow it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureRoot, removeFixtureRoot, runNode } from '../../lib/selftest-lib.mjs'
import { git_run } from '../../scripts/harness_git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const builderTemplate = path.join(here, 'templates/docs/build_docs.mjs')
const checkDocsTemplate = path.join(here, 'templates/docs/check_docs.mjs')
const verifyMap = path.join(here, '../../scripts/verify_map.mjs')
const harnessConfigSrc = path.join(here, '../../scripts/harness_config.mjs')
const harnessGitSrc = path.join(here, '../../scripts/harness_git.mjs')

const fx = fixtureRoot('build-docs-selftest')

// --- local helpers -------------------------------------------------------------------------------------
const j = (...p) => path.join(...p)
const rd = (p) => readFileSync(p, 'utf8')
const rm = (p) => rmSync(p, { recursive: true, force: true })
// Writes UTF-8 without a BOM and creates the parent directory.
const wr = (p, body) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body) }
const mk = (...dirs) => { for (const d of dirs) mkdirSync(d, { recursive: true }) }
// Case-insensitive "contains".
const has = (s, sub) => String(s).toLowerCase().includes(String(sub).toLowerCase())
// Stdout and stderr as one text, plus the exit code.
function nodeRun(args, { cwd, env } = {}) {
  const r = runNode(args, { cwd, env, input: '' })
  return { Out: r.stdout + r.stderr, Code: r.status }
}
// The environment with some variables replaced. On Windows the names ignore case, so a copy that
// keeps `Path` and adds `PATH` would hand the child two spellings of one variable.
function envWith(over) {
  const e = { ...process.env }
  for (const k of Object.keys(over)) {
    for (const have of Object.keys(e)) if (process.platform === 'win32' ? have.toLowerCase() === k.toLowerCase() : have === k) delete e[have]
    e[k] = over[k]
  }
  return e
}
// A literal replace of every occurrence, because a string replacement in String.replace expands `$&` and friends.
const replaceAll = (text, find, rep) => text.split(find).join(rep)
const group = (m, i) => (m?.[i] ?? '')
const count = (text, sub) => text.split(sub).length - 1
const readJson = (p) => { try { return JSON.parse(rd(p)) } catch { return null } }
const hjson = (repo, v) => wr(j(repo, '.harness.json'), typeof v === 'string' ? v : JSON.stringify(v))
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// One check is one test. The caller computes cond, so a thrown error there stops the suite loudly.
async function check(name, cond, detail = '') {
  await test(name, () => { assert.ok(cond, String(detail ?? '') || 'condition false') })
}

// Each fixture builds the corpus in a fresh docs tree with the builder copied in.
function docsTree(repo, docsName = 'docs') {
  const d = j(repo, docsName)
  mk(j(d, 'adr'), j(d, 'spec'))
  copyFileSync(builderTemplate, j(d, 'build_docs.mjs'))
  return d
}

try {
  const repo = j(fx, 'repo')
  const docs = docsTree(repo)
  const docDoc = (rel, body) => wr(j(docs, rel), body)
  const build = () => nodeRun([j(docs, 'build_docs.mjs')])
  const map = () => nodeRun([verifyMap, '--repo', repo, 'x.py'])

  // The base corpus. 0001 carries a lead HTML comment before the frontmatter, the onboarding shape
  // that split_frontmatter tolerates and the edge where the two digest implementations could diverge.
  docDoc('adr/0001-first.md', '<!-- template note kept above the frontmatter -->\n---\nid: "0001"\ntype: adr\ntitle: "first"\nstatus: accepted\n---\n# 0001\nbody v1\n')
  docDoc('adr/0002-second.md', '---\nid: "0002"\ntype: adr\ntitle: "second"\nstatus: proposed\n---\n# 0002\nbody\n')
  docDoc('spec/0001-spec.md', '---\nid: "0001"\ntype: spec\ntitle: "s1"\nstatus: active\nimplements_in: ["src/app.py"]\n---\n# spec 0001\n')

  // --- A: a clean corpus builds, and the same id across kinds is legal (adr: and spec: namespaces) --
  const rA = build()
  await check('A1 A clean build exits 0 (adr 0001 + spec 0001 coexist)', rA.Code === 0, `exit=${rA.Code}: ${rA.Out}`)
  const idx = j(docs, 'index.json')
  const json = readJson(idx)
  await check('A2 A index.json parses and counts match', json && json.counts?.adr === 2 && json.counts?.spec === 1, rA.Out)
  await check('A3 A fm_digest is stamped (64 hex)', json && /^[0-9a-f]{64}$/i.test(json.fm_digest ?? ''), `fm_digest='${json?.fm_digest}'`)

  // --- B: a duplicate id within a kind refuses to build and names both files (ADR 0043) ---------
  docDoc('adr/0002-rival.md', '---\nid: "0002"\ntype: adr\ntitle: "rival from a parallel branch"\nstatus: proposed\n---\n# 0002 again\n')
  const rB = build()
  await check('B1 B duplicate adr id exits non-zero', rB.Code !== 0, `exit=${rB.Code}: ${rB.Out}`)
  await check('B1b B the refusal names BOTH files', /0002-second\.md/i.test(rB.Out) && /0002-rival\.md/i.test(rB.Out), rB.Out)
  rm(j(docs, 'adr/0002-rival.md'))

  // --- B2: an unreadable "document", a directory whose name matches the doc pattern, is a named
  // refusal and not a traceback, like the duplicate-id refusal. Reading a directory raises an error
  // on both Windows (EISDIR or EPERM) and Linux (EISDIR).
  mk(j(docs, 'adr/0003-actually-a-dir.md'))
  const rB2 = build()
  await check('B2 an unreadable doc is a named refusal, not a traceback',
    rB2.Code !== 0 && /0003-actually-a-dir\.md/i.test(rB2.Out) && !/Traceback/i.test(rB2.Out), rB2.Out)
  rm(j(docs, 'adr/0003-actually-a-dir.md'))

  // --- C: rebuild clean, then the pairing: verify_map recomputes the same digest ------------------
  const rC = build()
  await check('C1 C corpus builds clean again', rC.Code === 0, rC.Out)
  const rMap = map()
  await check('C2 C verify_map sees a current index (no STALE, no missing-stamp note)',
    rMap.Code === 0 && !/index: STALE/i.test(rMap.Out) && !/no staleness stamp/i.test(rMap.Out), rMap.Out)

  // --- D: a body-only edit does not read as stale, the cry-wolf pin (the retro's D2 rule) --------
  docDoc('adr/0001-first.md', '<!-- template note kept above the frontmatter -->\n---\nid: "0001"\ntype: adr\ntitle: "first"\nstatus: accepted\n---\n# 0001\nbody v1\n\n## Addendum\nappend-only correction, frontmatter untouched\n')
  const rD = map()
  await check('D1 D a body-only edit does NOT flip the digest', !/index: STALE/i.test(rD.Out), rD.Out)

  // --- E: a frontmatter edit reads as stale until rebuilt, then clears ----------------------------
  docDoc('adr/0002-second.md', '---\nid: "0002"\ntype: adr\ntitle: "second"\nstatus: accepted\n---\n# 0002\nbody\n')
  const rE = map()
  await check('E1 E a frontmatter edit reads as STALE', /index: STALE/i.test(rE.Out), rE.Out)
  await check('E1b E the stale line names the rebuild command', /docs\/build\.mjs/i.test(rE.Out), rE.Out)
  build()
  const rE2 = map()
  await check('E2 rebuilding clears the stale signal', !/index: STALE/i.test(rE2.Out), rE2.Out)

  // --- F: a stamp-less index is reported, never silent (ADR 0043) ---------------------------------
  const raw = readJson(idx)
  delete raw.fm_digest
  writeFileSync(idx, JSON.stringify(raw, null, 2))
  const rF = map()
  await check('F1 F a missing stamp is reported (not silent, not STALE)',
    /no staleness stamp/i.test(rF.Out) && !/index: STALE/i.test(rF.Out), rF.Out)

  // --- G: a relocated corpus (a customized docs.index). The digest tracks the siblings of the
  // declared index, never a hardcoded docs/. A hardcoded path would read as STALE forever in this
  // supported configuration, and the default-layout cases above can never catch it.
  const repo2 = j(fx, 'repo-moved')
  const docs2 = docsTree(repo2, 'platform-docs')
  wr(j(repo2, '.harness.json'), '{ "docs": { "index": "platform-docs/index.json" } }')
  wr(j(docs2, 'adr/0001-a.md'), '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: accepted\n---\n# 0001\n')
  const rG = nodeRun([j(docs2, 'build_docs.mjs')])
  const gOk = rG.Code === 0
  const rGmap = nodeRun([verifyMap, '--repo', repo2, 'x.py'])
  await check('G1 G a relocated corpus builds and reads as current (no false STALE)',
    gOk && !/index: STALE/i.test(rGmap.Out) && !/no staleness stamp/i.test(rGmap.Out), `build: ${rG.Out}\nmap: ${rGmap.Out}`)
  wr(j(docs2, 'adr/0001-a.md'), '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: superseded\n---\n# 0001\n')
  const rG2 = nodeRun([verifyMap, '--repo', repo2, 'x.py'])
  await check('G2 the relocated corpus still yields a real signal on a frontmatter edit', /index: STALE/i.test(rG2.Out), rG2.Out)

  // --- H: site title resolution (ADR 0050). The declaration is the source, and the env var is a
  // one-off override. With env-only sourcing, any caller that did not set DOCS_SITE_TITLE, such as a
  // harness-init re-run or CI, would rebuild committed surfaces with the default title.
  // Cases A to F double as the no-declaration control: their fixture has no .harness.json anywhere
  // up the temp tree, and their builds carry the default title.
  const repo3 = j(fx, 'repo-title')
  const docs3 = docsTree(repo3)
  wr(j(docs3, 'adr/0001-a.md'), '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: accepted\n---\n# 0001\n')
  const titleBuild = (env) => nodeRun([j(docs3, 'build_docs.mjs')], { env })

  hjson(repo3, '{ "docs": { "site_title": "myrepo - internal docs" } }')
  const rH = titleBuild()
  const h1 = rd(j(docs3, 'docs.html'))
  const h1a = rd(j(docs3, 'docs.artifact.html'))
  await check('H1 H a declared docs.site_title lands in BOTH generated <title>s (no env var set)',
    rH.Code === 0 && /<title>myrepo - internal docs<\/title>/i.test(h1) && /<title>myrepo - internal docs<\/title>/i.test(h1a), `exit=${rH.Code}: ${rH.Out}`)

  // H2: the env var wins when set, because it is an override and not the source.
  const rH2 = titleBuild(envWith({ DOCS_SITE_TITLE: 'one-off override' }))
  const h2 = rd(j(docs3, 'docs.html'))
  await check('H2 DOCS_SITE_TITLE overrides the declaration when set',
    rH2.Code === 0 && /<title>one-off override<\/title>/i.test(h2), `exit=${rH2.Code}: ${rH2.Out}`)

  // H3: a declaration without site_title, or with an empty one, falls back to the default title.
  hjson(repo3, '{ "docs": { "index": "docs/index.json", "site_title": "" } }')
  const rH3 = titleBuild()
  const h3 = rd(j(docs3, 'docs.html'))
  await check('H3 an empty site_title falls back to the default',
    rH3.Code === 0 && /<title>Docs · ADR &amp; Spec<\/title>/i.test(h3), `exit=${rH3.Code}: ${rH3.Out}`)

  // H4: an unreadable declaration is a reported fallback, never silent and never fatal. A silent
  // revert is the defect that the resolution order exists to remove.
  hjson(repo3, '{ not json')
  const rH4 = titleBuild()
  const h4 = rd(j(docs3, 'docs.html'))
  await check('H4 a malformed declaration warns, builds, and uses the default title',
    rH4.Code === 0 && /unreadable/i.test(rH4.Out) && /<title>Docs · ADR &amp; Spec<\/title>/i.test(h4), `exit=${rH4.Code}: ${rH4.Out}`)

  // H5: the upward walk stops at a repo boundary. A repo without a declaration must not adopt an
  // unrelated ancestor's .harness.json title, so a directory with .git and no declaration ends the
  // walk at the default.
  const outer = j(fx, 'outer-tree')
  const inner = j(outer, 'repo', 'docs')
  mk(j(inner, 'adr'), j(inner, 'spec'), j(outer, 'repo', '.git'))
  wr(j(outer, '.harness.json'), '{ "docs": { "site_title": "ancestor title MUST NOT leak" } }')
  copyFileSync(builderTemplate, j(inner, 'build_docs.mjs'))
  wr(j(inner, 'adr/0001-a.md'), '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: accepted\n---\n# 0001\n')
  nodeRun([j(inner, 'build_docs.mjs')])
  const h5 = rd(j(inner, 'docs.html'))
  await check('H5 a .git boundary without a declaration stops the walk at the default',
    /<title>Docs · ADR &amp; Spec<\/title>/i.test(h5) && !/ancestor title/i.test(h5), h5.slice(0, 300))
  // H5b control: the same tree without the .git marker is a plain nested docs tree, where walking
  // to the ancestor declaration is intended (the relocated-corpus class, case G). This pins that H5
  // measures the boundary and not a broken walk.
  rm(j(outer, 'repo', '.git'))
  nodeRun([j(inner, 'build_docs.mjs')])
  const h5b = rd(j(inner, 'docs.html'))
  await check('H5b without the boundary the ancestor declaration is honored (walk intact)',
    /ancestor title MUST NOT leak/i.test(h5b), h5b.slice(0, 300))

  // --- I: the customer-corpus surface (ADR 0060) --------------------------------------------
  // The fixture is a repo with a two-program corpus and a copy of the vendored harness_config.mjs
  // that the builder imports. "xgglbsrp" carries a menu (25.x, which groups to the declared 25.x
  // label) and 3 release entries: two same-date [UAT] (dedupe and tie-break) and one older [FUT].
  // "batchjob" carries no menu (it falls to unkeyed_label) and one [PROD] entry, which gives
  // posture 완료 and recency-group membership because it has release history.
  const repoI = j(fx, 'repo-customer')
  const docsI = j(repoI, 'docs')
  const custI = j(docsI, 'customer')
  mk(j(docsI, 'adr'), j(docsI, 'spec'), j(custI, 'xgglbsrp'), j(custI, 'batchjob'), j(repoI, 'scripts/harness'))
  copyFileSync(builderTemplate, j(docsI, 'build_docs.mjs'))
  copyFileSync(harnessConfigSrc, j(repoI, 'scripts/harness/harness_config.mjs'))
  copyFileSync(harnessGitSrc, j(repoI, 'scripts/harness/harness_git.mjs'))
  const writeIDoc = (rel, body) => wr(j(docsI, rel), body)
  const buildI = () => nodeRun([j(docsI, 'build_docs.mjs')])

  writeIDoc('adr/0001-a.md', '---\nid: "0001"\ntype: adr\ntitle: "fixture adr"\nstatus: accepted\n---\n# 0001\nbody\n')
  // The fence markers below are literal ``` sequences, so the body is built from lines, not a template.
  const spec0001 = [
    '---', 'id: "0001"', 'type: spec', 'title: "fixture spec"', 'status: active', '---',
    '# spec 0001',
    '- item one', '  continued on a hard-wrapped line', '- item two',
    'Plain paragraph right after the list without a blank line',
    '',
    '- item three', '| c | d |', '|---|---|', '| 3 | 4 |',
    '',
    '- item four', '## Heading right after a list',
    '',
    '| a | b |', '|---|---|', '| 1 | 2 |',
    '',
    '```diff', '+added line', '-removed line', '```',
  ].join('\n')
  writeIDoc('spec/0001-s.md', spec0001)

  writeIDoc('customer/xgglbsrp/spec.md', '---\nprogram: xgglbsrp\ntitle: "xgglbsrp spec"\nupdated: 2026-08-20\nprogram_file: xgglbsrp\nmenu: "25.15.1"\nproject: P1\n---\n# spec\nBody.\n')
  writeIDoc('customer/xgglbsrp/user-guide.md', '---\nprogram: xgglbsrp\ntitle: "xgglbsrp guide"\nupdated: 2026-08-20\n---\n# guide\nBody.\n')
  const rnXgBody = '---\nprogram: xgglbsrp\ntitle: "xgglbsrp release notes"\nupdated: 2026-08-20\n---\n## 2026-08-20 — Entry C [UAT]\n\nBody C.\n\n## 2026-08-20 — Entry B [UAT]\n\nBody B.\n\n## 2026-08-15 — Entry A [FUT]\n\nBody A.\n'
  writeIDoc('customer/xgglbsrp/release-notes.md', rnXgBody)

  writeIDoc('customer/batchjob/spec.md', '---\nprogram: batchjob\ntitle: "batchjob spec"\nupdated: 2026-08-10\nprogram_file: batchjob\n---\n# spec\nBody.\n')
  writeIDoc('customer/batchjob/user-guide.md', '---\nprogram: batchjob\ntitle: "batchjob guide"\nupdated: 2026-08-10\n---\n# guide\nBody.\n')
  const rnBjBody = '---\nprogram: batchjob\ntitle: "batchjob release notes"\nupdated: 2026-08-10\n---\n## 2026-08-10 — Batch fix [PROD]\n\nBody.\n'
  writeIDoc('customer/batchjob/release-notes.md', rnBjBody)

  const customerDecl = {
    dir: 'docs/customer',
    title: 'Fixture Repo · 고객 문서 — 테스트',
    eyebrow: '테스트 고객 문서',
    description: '테스트용 설명',
    contact: '테스트 문의처',
    chip_field: 'program_file',
    chip_suffix: '.p',
    groups: [{ label: '재무회계 (25.x)', keys: [25] }],
    other_label: '기타 메뉴',
    unkeyed_label: '배치·인터페이스·자동화',
    projects_md: true,
  }
  const declFull = { docs: { customer: customerDecl } }
  hjson(repoI, declFull)

  const custHtml = j(docsI, 'customer.artifact.html')
  const projMd = j(docsI, 'PROJECTS.md')

  // I1: a declared surface exits 0, both new surfaces exist, and the 4 internal surfaces are still written.
  rm(custHtml); rm(projMd)
  const rI1 = buildI()
  await check('I1 declared customer surface builds clean', rI1.Code === 0, rI1.Out)
  await check('I1 customer.artifact.html written', existsSync(custHtml), rI1.Out)
  await check('I1 PROJECTS.md written (projects_md: true)', existsSync(projMd), rI1.Out)
  await check('I1 the 4 internal surfaces are still written',
    existsSync(j(docsI, 'index.json')) && existsSync(j(docsI, 'docs.html')) && existsSync(j(docsI, 'docs.artifact.html')), rI1.Out)

  const custText = existsSync(custHtml) ? rd(custHtml) : ''

  // I2: the sidebar has the recency group first and the declared 25.x group label, and batchjob sits
  // under the unkeyed label (its own pgroup section names it and contains its progitem).
  const idxRecent = custText.indexOf('최근 업데이트')
  const idx25 = custText.indexOf('재무회계 (25.x)')
  await check('I2 recency group label present before the declared 25.x group',
    idxRecent >= 0 && idx25 >= 0 && idxRecent < idx25, `recent=${idxRecent} 25.x=${idx25}`)
  const unkeyedSection = group(/배치·인터페이스·자동화[\s\S]*?<\/section>/.exec(custText), 0)
  await check('I2 batchjob sits under the unkeyed_label group',
    unkeyedSection && /data-prog="batchjob"/i.test(unkeyedSection), unkeyedSection)

  // I3: the HTML chip renders the bare <chip_field value>. `chip_suffix` belongs to the file-form
  // listing of PROJECTS.md only (I5).
  await check('I3 chip renders the bare xgglbsrp (no suffix in HTML)',
    /chip mono">xgglbsrp<\/span>/i.test(custText) && !/chip mono">xgglbsrp\.p<\/span>/i.test(custText), rI1.Out)

  // I4: the two adjacent same-date [UAT] entries dedupe to one badge in the rendered article, PROD
  // renders as COMPLETE, and the postures match (xgglbsrp 진행 중, batchjob 완료).
  const xgArticle = group(/<article class="prog[^"]*" id="prog-xgglbsrp">[\s\S]*?<\/article>/.exec(custText), 0)
  const uatBadges = count(xgArticle, 'class="relstat rs-uat"')
  await check('I4 adjacent same-state UAT badges dedupe to exactly one in the article', uatBadges === 1, `count=${uatBadges}\n${xgArticle}`)
  await check('I4 PROD renders as COMPLETE', /rs-prod">COMPLETE</i.test(custText), rI1.Out)
  await check('I4 xgglbsrp posture is 진행 중 (top entry is UAT, not final)',
    /data-prog="xgglbsrp"[\s\S]{0,400}?진행 중/i.test(custText), rI1.Out)
  await check('I4 batchjob posture is 완료 (top entry is PROD, final)',
    /data-prog="batchjob"[\s\S]{0,400}?완료/i.test(custText), rI1.Out)

  // I5: PROJECTS.md has one project (#P1) and one sorted member (xgglbsrp, with chip and title).
  const projText = existsSync(projMd) ? rd(projMd) : ''
  await check('I5 PROJECTS.md names the P1 project', /## #P1/i.test(projText), projText)
  await check('I5 PROJECTS.md lists xgglbsrp with its chip + title',
    /- xgglbsrp \(`xgglbsrp\.p`\) — xgglbsrp spec/i.test(projText), projText)

  // I5b: the initial article is the head of the recency group, the program with the newest release
  // entry (xgglbsrp, 2026-08-20), and not the ASCII-first directory (batchjob) that `programs[0]`
  // names. Article `.on` and every sidebar `aria-current="true"` must agree on the same id, because
  // the program sits in the recency group and in its declared group. No other program may carry either.
  const onIds = [...custText.matchAll(/<article class="prog on" id="prog-([^"]+)">/g)].map((m) => m[1])
  await check('I5b exactly one article opens, and it is the newest-release program (xgglbsrp), not the ASCII-first one',
    onIds.length === 1 && onIds[0] === 'xgglbsrp', `on-articles=${onIds.join(',')}`)
  const curItems = [...custText.matchAll(/<button type="button" class="progitem" data-prog="([^"]+)"[^>]*aria-current="true"/g)]
  const curIds = [...new Set(curItems.map((m) => m[1]))].sort()
  await check('I5b every aria-current sidebar item names xgglbsrp (recency + declared group), no other program',
    curItems.length >= 1 && curIds.length === 1 && curIds[0] === 'xgglbsrp', `current=${curIds.join(',')} n=${curItems.length}`)
  await check('I5b batchjob article is NOT opened and its sidebar item is not current',
    /<article class="prog" id="prog-batchjob">/i.test(custText) && !/data-prog="batchjob"[^>]*aria-current="true"/i.test(custText), rI1.Out)

  // I5c: the fallback. No program has release history (both release-notes.md bodies lack an entry
  // heading), so there is no recency group and the initial article is programs[0] (batchjob, sort order).
  writeIDoc('customer/xgglbsrp/release-notes.md', '---\nprogram: xgglbsrp\ntitle: "xgglbsrp release notes"\nupdated: 2026-08-20\n---\n아직 릴리즈 이력이 없습니다.\n')
  writeIDoc('customer/batchjob/release-notes.md', '---\nprogram: batchjob\ntitle: "batchjob release notes"\nupdated: 2026-08-10\n---\n아직 릴리즈 이력이 없습니다.\n')
  const rI5c = buildI()
  await check('I5c a corpus with no release history still builds', rI5c.Code === 0, rI5c.Out)
  const noRelText = rd(custHtml)
  const noRelOn = [...noRelText.matchAll(/<article class="prog on" id="prog-([^"]+)">/g)].map((m) => m[1])
  await check('I5c with no release history the initial article falls back to programs[0] (batchjob), exactly one',
    noRelOn.length === 1 && noRelOn[0] === 'batchjob' && !/최근 업데이트/i.test(noRelText), `on-articles=${noRelOn.join(',')}`)
  await check('I5c the fallback sidebar item is batchjob and only batchjob',
    /data-prog="batchjob"[^>]*aria-current="true"/i.test(noRelText) && !/data-prog="xgglbsrp"[^>]*aria-current="true"/i.test(noRelText), rI5c.Out)
  // With no recency group, the current item must not sit inside a collapsed (display:none) group.
  // The group that holds first_id opens, and the other declared group stays collapsed.
  const bjSection = /<section class="pgroup"><button type="button" class="pghead" aria-expanded="([^"]+)">[^<]*<span class="pgarrow">▸<\/span>배치·인터페이스·자동화[\s\S]*?<div class="pgitems([^"]*)">/.exec(noRelText)
  const xgSection = /<section class="pgroup"><button type="button" class="pghead" aria-expanded="([^"]+)">[^<]*<span class="pgarrow">▸<\/span>재무회계 \(25\.x\)[\s\S]*?<div class="pgitems([^"]*)">/.exec(noRelText)
  await check('I5c the fallback opens the group that holds the current item (aria-expanded + pgitems on)',
    group(bjSection, 1) === 'true' && group(bjSection, 2) === ' on', `expanded=${group(bjSection, 1)} pgitems='${group(bjSection, 2)}'`)
  await check('I5c the other declared group stays collapsed in the fallback',
    group(xgSection, 1) === 'false' && group(xgSection, 2) === '', `expanded=${group(xgSection, 1)} pgitems='${group(xgSection, 2)}'`)
  writeIDoc('customer/xgglbsrp/release-notes.md', rnXgBody)
  writeIDoc('customer/batchjob/release-notes.md', rnBjBody)

  // I6: "customer": null exits 0, writes no customer.artifact.html or PROJECTS.md, and lists 4 surfaces.
  rm(custHtml); rm(projMd)
  hjson(repoI, '{ "docs": { "customer": null } }')
  const rI6 = buildI()
  await check('I6 customer: null exits 0', rI6.Code === 0, rI6.Out)
  await check('I6 no customer.artifact.html is written', !existsSync(custHtml), rI6.Out)
  await check('I6 no PROJECTS.md is written', !existsSync(projMd), rI6.Out)
  await check('I6 output lists the 4 internal surfaces, nothing customer-shaped',
    /docs\.artifact\.html/i.test(rI6.Out) && !/customer\.artifact\.html/i.test(rI6.Out), rI6.Out)
  hjson(repoI, declFull)

  // I7: a missing required file names the exact path and prints no traceback.
  const ugPath = j(custI, 'xgglbsrp/user-guide.md')
  const ugBody = rd(ugPath)
  rm(ugPath)
  const rI7 = buildI()
  await check('I7 a missing user-guide.md is a named refusal, not a traceback',
    rI7.Code !== 0 && has(rI7.Out, 'docs/customer/xgglbsrp/user-guide.md') && !/Traceback/i.test(rI7.Out), rI7.Out)
  wr(ugPath, ugBody)

  // I8: a program that differs from its dirname names the file and the key.
  const specPath = j(custI, 'xgglbsrp/spec.md')
  const specBody = rd(specPath)
  writeIDoc('customer/xgglbsrp/spec.md', '---\nprogram: WRONG\ntitle: "xgglbsrp spec"\nupdated: 2026-08-20\nprogram_file: xgglbsrp\nmenu: "25.15.1"\nproject: P1\n---\n# spec\nBody.\n')
  const rI8 = buildI()
  await check('I8 program != dirname exits 1 naming the file and the key',
    rI8.Code !== 0 && has(rI8.Out, 'docs/customer/xgglbsrp/spec.md') && /program/i.test(rI8.Out), rI8.Out)
  wr(specPath, specBody)

  // I9: a spec.md without the chip_field key (program_file) exits 1.
  writeIDoc('customer/xgglbsrp/spec.md', '---\nprogram: xgglbsrp\ntitle: "xgglbsrp spec"\nupdated: 2026-08-20\nmenu: "25.15.1"\nproject: P1\n---\n# spec\nBody.\n')
  const rI9 = buildI()
  await check('I9 a missing declared chip_field key on spec.md exits 1', rI9.Code !== 0, rI9.Out)
  wr(specPath, specBody)

  // I10: a malformed block (a dir that escapes the repo) exits 1 and reports it as unusable.
  hjson(repoI, '{ "docs": { "customer": { "dir": "../x" } } }')
  const rI10 = buildI()
  await check('I10 a malformed docs.customer block exits 1 and says 사용 불가', rI10.Code !== 0 && /사용 불가/i.test(rI10.Out), rI10.Out)
  hjson(repoI, declFull)

  // I11: an absent reader (scripts/harness/ renamed away) exits 1 and names its path. It is a
  // refusal, not a silent 4-surface fallback. The 4 internal surfaces may already be on disk from
  // an earlier successful build, because main() writes them before it attempts the customer
  // surface, so this case asserts the refusal shape only.
  const hcDir = j(repoI, 'scripts/harness')
  const hcMoved = j(repoI, 'scripts/harness-moved')
  renameSync(hcDir, hcMoved)
  const rI11 = buildI()
  // reader_path is built with a path join, so on Windows it uses backslashes. The match accepts
  // either separator, unlike the other exit messages, which format the declared dir as a string.
  await check('I11 an absent reader exits 1 naming scripts/harness/harness_config.mjs',
    rI11.Code !== 0 && /scripts[\\/]harness[\\/]harness_config\.mjs/i.test(rI11.Out), rI11.Out)
  renameSync(hcMoved, hcDir)

  // I12: the `declared` contract. An explicit "" stays blank, and an absent key gets the builder's
  // own UI default.
  hjson(repoI, { docs: { customer: { ...customerDecl, eyebrow: '' } } })
  const rI12a = buildI()
  const c12a = rd(custHtml)
  await check('I12 eyebrow declared as "" renders an empty eyebrow element',
    rI12a.Code === 0 && /<div class="eyebrow"><\/div>/i.test(c12a), rI12a.Out)
  hjson(repoI, { docs: { customer: { dir: 'docs/customer', chip_field: 'program_file', chip_suffix: '.p', groups: [{ label: 'g', keys: [25] }], projects_md: true } } })
  const rI12b = buildI()
  const c12b = rd(custHtml)
  await check('I12 eyebrow ABSENT falls back to the builder default 고객 문서',
    rI12b.Code === 0 && /<div class="eyebrow">고객 문서<\/div>/i.test(c12b), rI12b.Out)
  hjson(repoI, declFull)
  buildI()

  // I13: _selfcheck_release_helpers() passes standalone through a node import probe.
  // The sentinel is assembled at runtime and the exit code is asserted too. A failing run's
  // traceback can echo the command source, so a literal sentinel in the command would match itself
  // on a failing run.
  const bdUrl = pathToFileURL(j(docsI, 'build_docs.mjs')).href
  const rI13 = nodeRun(['--input-type=module', '-e', `import { _selfcheck_release_helpers } from ${JSON.stringify(bdUrl)}; _selfcheck_release_helpers(); console.log('SELF' + 'CHECK-' + 'OK')`])
  await check('I13 _selfcheck_release_helpers() passes standalone (exit 0, sentinel printed, no traceback)',
    rI13.Code === 0 && /SELFCHECK-OK/i.test(rI13.Out) && !/Traceback/i.test(rI13.Out), `exit=${rI13.Code} ${rI13.Out}`)

  // I14: a declared panel module contributes a top-level tab, and a missing module exits 1.
  const panelsDir = j(repoI, 'scripts/panels')
  mk(panelsDir)
  wr(j(panelsDir, 'demo.mjs'), "export const CSS = '.demo{color:red}'\nexport function render_panel(root) { return '<p class=\"demo\">PANEL-OK</p>' }\n")
  const panelDecl = (panels, extra = {}) => ({ docs: { customer: { dir: 'docs/customer', chip_field: 'program_file', chip_suffix: '.p', groups: [{ label: 'g', keys: [25] }], panels, ...extra } } })
  hjson(repoI, panelDecl([{ module: 'scripts/panels/demo.mjs', label: '데모' }]))
  const rI14 = buildI()
  const c14 = existsSync(custHtml) ? rd(custHtml) : ''
  await check('I14 a declared panel module renders its fragment + CSS + tab',
    rI14.Code === 0 && /PANEL-OK/i.test(c14) && /\.demo\{color:red\}/i.test(c14) && />데모</i.test(c14), rI14.Out)
  // I14 (ADR 0061 defaults): with none of the new keys the docs tab is first and initially selected,
  // the panel id is derived (Korean label to `panel-0`), and the footer label is 문서 생성일 over the
  // corpus max. The `panel-<id>` scope class is the only addition.
  await check('I14 no new keys → docs first + selected, derived id panel-0, default footer label (pre-0061 shape + scope class)',
    /<div class="toptabs" role="tablist"><button type="button" class="toptab" role="tab" data-top="docs" aria-selected="true">/i.test(c14)
    && /data-top="panel-0" aria-selected="false">데모<\/button>/i.test(c14)
    && /<div class="toppanel on" data-top="docs">/i.test(c14)
    && /<div class="toppanel panel-panel-0" data-top="panel-0">/i.test(c14)
    && /<span>문서 생성일 2026-08-20<\/span>/i.test(c14), rI14.Out)
  hjson(repoI, panelDecl([{ module: 'scripts/panels/missing.mjs', label: '없음' }]))
  const rI14b = buildI()
  await check('I14b a missing panel module exits 1 naming it',
    rI14b.Code !== 0 && has(rI14b.Out, 'scripts/panels/missing.mjs'), rI14b.Out)
  hjson(repoI, declFull)

  // I15: generic markdown rules, asserted on the base fixture's own docs.html. A hard-wrapped list
  // item renders as one <li>, a ```diff fence colors a + line, and a table gets a tblwrap.
  buildI()
  const docsHtml = rd(j(docsI, 'docs.html'))
  const liCount = count(docsHtml, '<li>item one continued on a hard-wrapped line</li>')
  await check('I15 a hard-wrapped list item renders as ONE <li>', liCount === 1, docsHtml)
  await check('I15 a ```diff fence colors the + line', /<span class="d-add">\+added line<\/span>/i.test(docsHtml), docsHtml)
  await check('I15 a table is wrapped in tblwrap', /<div class="tblwrap"><table>/i.test(docsHtml), docsHtml)
  // I15 negatives: the continuation rule is CommonMark's lazy continuation for indented lines only.
  // A non-indented paragraph, a table and a heading that directly follow a list item must not be
  // swallowed into the <li>.
  await check('I15n a NON-indented line after a list item stays a separate paragraph',
    /<li>item two<\/li>/i.test(docsHtml) && /<p>Plain paragraph right after the list without a blank line<\/p>/i.test(docsHtml), docsHtml)
  await check('I15n a table directly after a list item is not swallowed',
    /<li>item three<\/li>/i.test(docsHtml) && /<th>c<\/th>/i.test(docsHtml), docsHtml)
  await check('I15n a heading directly after a list item is not swallowed',
    /<li>item four<\/li>/i.test(docsHtml) && /<h2>Heading right after a list<\/h2>/i.test(docsHtml), docsHtml)

  // I16: a stale vendored reader, present and importable but without customer_decl and
  // cfg["customer"] (ADR 0060), is the real state when a repo fills the declaration before
  // harness-init re-runs. It must be a named exit, never an uncaught exception trace.
  const hcReal = j(repoI, 'scripts/harness')
  renameSync(hcReal, j(repoI, 'scripts/harness-real'))
  mk(hcReal)
  wr(j(hcReal, 'harness_config.mjs'), "export function load(root) { return [{ index: 'docs/index.json' }, []] }\n")
  rm(j(docsI, 'index.json'))
  const rI16 = buildI()
  await check('I16 a stale reader (no customer support) exits 1 naming it as 구버전, no traceback',
    rI16.Code !== 0 && /구버전/i.test(rI16.Out) && /harness_config\.mjs/i.test(rI16.Out) && !/Traceback/i.test(rI16.Out), rI16.Out)
  // I17: write order. A refused customer build must not leave the 4 internal surfaces freshly
  // written next to a stale customer page. index.json was deleted above and the refusal fired, so
  // it must still be absent.
  await check('I17 a refused customer build writes NO surface at all (index.json stays absent)',
    !existsSync(j(docsI, 'index.json')), 'index.json was written before the customer refusal')
  rm(hcReal)
  renameSync(j(repoI, 'scripts/harness-real'), hcReal)

  // I14c: a panel module whose render_panel() raises is a named exit, not a traceback. The guard
  // covers the call as well as the import.
  wr(j(panelsDir, 'boom.mjs'), "export function render_panel(root) { throw new Error('boom') }\n")
  hjson(repoI, panelDecl([{ module: 'scripts/panels/boom.mjs', label: '붐' }]))
  const rI14c = buildI()
  await check('I14c a raising render_panel() exits 1 naming the module, no traceback',
    rI14c.Code !== 0 && /render_panel/i.test(rI14c.Out) && has(rI14c.Out, 'scripts') && /boom/i.test(rI14c.Out) && !/Traceback/i.test(rI14c.Out), rI14c.Out)

  // I19: the declaration keys of ADR 0061. `first` is declared before-docs with an id, TAB_CHIPS and
  // an UPDATED newer than the corpus. `demo` keeps its unscoped `.demo{}` rule. The expected result:
  // tab order first, docs, demo. `first` is the initial tab (default_tab) with its chips, and the
  // docs panel is not `on`. Each panel container carries `panel-<id>`. The footer reads the declared
  // label and the panel's newer date. `leak` reuses the canon classes `.mono` and `.chip.on` with no
  // panel-owned class in the selector, which draws a warning. Its `.panel-leak .chip` and `.own .clip`
  // rules (scoped by a panel-owned class), its own `.pf-x`, and demo's own `.demo` draw none,
  // because unique names leak into nothing.
  wr(j(panelsDir, 'first.mjs'),
    "export const UPDATED = '2026-09-01'\nexport const TAB_CHIPS = ['칩A', '칩<B>']\nexport const CSS = '.panel-first .pf{color:blue}'\nexport function render_panel(root) { return '<p class=\"pf\">FIRST-OK</p>' }\n")
  wr(j(panelsDir, 'leak.mjs'), `export const CSS = "/* .clip in a comment */ .mono{color:red} .chip.on{x:y} .panel-leak .chip{color:blue} .own .clip{x:y} .pf-x{background:url(a.png)} a[href$='.clip']{x:y} [data-k='.tblwrap'] b{x:y}"
export function render_panel(root) { return '<p>LEAK</p>' }
`)
  hjson(repoI, panelDecl([
    { module: 'scripts/panels/demo.mjs', label: '데모', id: 'demo' },
    { module: 'scripts/panels/first.mjs', label: '첫 탭', id: 'first', position: 'before-docs' },
    { module: 'scripts/panels/leak.mjs', label: '누출', id: 'leak' },
  ], { default_tab: 'first', footer_date_label: '최종 갱신' }))
  const rI19 = buildI()
  const c19 = existsSync(custHtml) ? rd(custHtml) : ''
  const tablist19 = group(/<div class="toptabs" role="tablist">([\s\S]*?)<\/div>/.exec(c19), 1)
  await check('I19 tab order = before-docs panel, docs, after-docs panel; default_tab is the initial tab with its chips',
    rI19.Code === 0
    && tablist19.indexOf('data-top="first"') >= 0
    && tablist19.indexOf('data-top="first"') < tablist19.indexOf('data-top="docs"')
    && tablist19.indexOf('data-top="docs"') < tablist19.indexOf('data-top="demo"')
    && /data-top="first" aria-selected="true">첫 탭<span class="chip">칩A<\/span><span class="chip">칩&lt;B&gt;<\/span><\/button>/i.test(tablist19)
    && /data-top="docs" aria-selected="false">문서 모음 <span class="chip">명세 2건<\/span>/i.test(tablist19)
    && /<div class="toppanel panel-first on" data-top="first"><p class="pf">FIRST-OK<\/p><\/div>/i.test(c19)
    && /<div class="toppanel" data-top="docs"><div class="docview">/i.test(c19)
    && /<div class="toppanel panel-demo" data-top="demo"><p class="demo">PANEL-OK<\/p><\/div>/i.test(c19), `${rI19.Out}\n${tablist19}`)
  await check('I19 footer = declared footer_date_label + max(corpus updated, panel UPDATED)',
    /<span>최종 갱신 2026-09-01<\/span>/i.test(c19), c19.replace(/[\s\S]*<footer/, '<footer'))
  await check('I19 a panel selector reusing a canon class outside .panel-<id> is warned about (naming the fix), unique/scoped names are not, never refused',
    rI19.Code === 0 && has(rI19.Out, "'.mono'") && has(rI19.Out, "'.mono' 를")
    && has(rI19.Out, '.panel-leak .mono') && has(rI19.Out, 'scripts/panels/leak.mjs')
    && has(rI19.Out, "'.chip.on'") && !has(rI19.Out, "'.panel-leak .chip'")
    && !has(rI19.Out, "'.demo'") && !/pf-x/i.test(rI19.Out) && !/clip/i.test(rI19.Out) && !/tblwrap/i.test(rI19.Out)
    && count(rI19.Out, '[경고] 패널 CSS') === 2, rI19.Out)
  // I19c: the builder's own id fallback, which entries without `id` use, must not hand two panels
  // one data-top. The labels "Env" and "env" both slugify to `env`, so the second takes the first
  // free panel-<n>. This is a direct call, like I13.
  const repoIFwd = repoI.replace(/\\/g, '/')
  const rI19c = nodeRun(['--input-type=module', '-e',
    `import { _load_panels } from ${JSON.stringify(bdUrl)}; const ps = await _load_panels({ panels: [{ module: 'scripts/panels/demo.mjs', label: 'Env' }, { module: 'scripts/panels/demo.mjs', label: 'env' }, { module: 'scripts/panels/demo.mjs', label: '데모' }] }, ${JSON.stringify(repoIFwd)}); console.log('IDS=' + ps.map(p => p.id).join(','))`])
  await check('I19c builder fallback ids (no reader id) stay unique: env, panel-1, panel-2',
    rI19c.Code === 0 && /IDS=env,panel-1,panel-2/i.test(rI19c.Out), rI19c.Out)
  // I19b: a malformed UPDATED is a named refusal, as the module contract says, like a CSS that is not a string.
  wr(j(panelsDir, 'baddate.mjs'), "export const UPDATED = '2026/09/01'\nexport function render_panel(root) { return '<p>x</p>' }\n")
  hjson(repoI, panelDecl([{ module: 'scripts/panels/baddate.mjs', label: '날짜' }]))
  const rI19b = buildI()
  await check('I19b a panel UPDATED that is not YYYY-MM-DD exits 1 naming the module, no traceback',
    rI19b.Code !== 0 && /UPDATED/i.test(rI19b.Out) && /baddate/i.test(rI19b.Out) && !/Traceback/i.test(rI19b.Out), rI19b.Out)
  hjson(repoI, declFull)
  const rFinal = buildI()
  await check('I18 the fixture builds clean again after the failure cases (all 6 surfaces)',
    rFinal.Code === 0 && existsSync(j(docsI, 'index.json')) && existsSync(custHtml), rFinal.Out)

  // --- CK: --check mode (ADR 0074). It assembles the corpus as a normal build does and only compares.
  // The check_docs.mjs wrapper runs it, with no consumer-side mirror of the builder. A fresh, minimal
  // fixture without a customer declaration keeps the 4-surface set that the cases below reason about.
  const repoCK = j(fx, 'repo-check')
  const docsCK = docsTree(repoCK)
  const writeCKDoc = (rel, body) => wr(j(docsCK, rel), body)
  const buildCK = () => nodeRun([j(docsCK, 'build_docs.mjs')])
  const checkCK = () => nodeRun([j(docsCK, 'build_docs.mjs'), '--check'])

  writeCKDoc('adr/0001-a.md', '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: accepted\n---\n# 0001\nbody\n')
  buildCK()

  // CK1: a clean corpus checks clean with exit 0 and the OK summary line.
  const rCK1 = checkCK()
  await check('CK1 a clean corpus checks clean (exit 0, OK summary)',
    rCK1.Code === 0 && /\[check\] OK - /i.test(rCK1.Out) && /surface\(s\) match/i.test(rCK1.Out), rCK1.Out)

  // CK2: drift is reported and the check writes nothing. Mutation anchor: if the write loop ran on
  // the check path instead of only comparing, hashAfter would differ from hashBefore here.
  const idxCK = j(docsCK, 'index.json')
  appendFileSync(idxCK, 'x')
  const hashBefore = sha256(idxCK)
  const rCK2 = checkCK()
  const hashAfter = sha256(idxCK)
  await check('CK2 drift in index.json exits 1 and names it DRIFT',
    rCK2.Code === 1 && /\[check\] DRIFT\s+docs\/index\.json/i.test(rCK2.Out), rCK2.Out)
  await check('CK2 the check wrote NOTHING — hash unchanged across the --check call',
    hashBefore === hashAfter, `before=${hashBefore} after=${hashAfter}`)
  await check('CK2 the other surfaces still report OK',
    /\[check\] OK\s+docs\/INDEX\.md/i.test(rCK2.Out) && /\[check\] OK\s+docs\/docs\.html/i.test(rCK2.Out)
    && /\[check\] OK\s+docs\/docs\.artifact\.html/i.test(rCK2.Out), rCK2.Out)
  await check('CK2 the summary line words the failing count as "differ or are missing" (DRIFT + MISSING share one wording)',
    /differ or are missing/i.test(rCK2.Out), rCK2.Out)
  buildCK() // restores index.json to a clean state

  // CK3: an absent optional surface is reported and does not fail the check. docs.html is optional,
  // because the template gitignore does not track it and the canon commits only index.json and
  // INDEX.md (ADR 0003). This is the control for CK3b, where a missing required surface fails.
  rm(j(docsCK, 'docs.html'))
  const rCK3 = checkCK()
  await check('CK3 an absent OPTIONAL generated surface is ABSENT, not a failure (exit 0)',
    rCK3.Code === 0 && /\[check\] ABSENT\s+docs\/docs\.html/i.test(rCK3.Out), rCK3.Out)
  buildCK() // restores docs.html

  // CK3b: docs/index.json is required. The docs-as-code contract commits it, every consumer relies
  // on it, and the scaffold gitignore template does not ignore it. Its absence is MISSING and fails
  // the check with exit 1, unlike the optional docs.html of CK3. Mutation anchor: treating every
  // absent surface as ABSENT flips this case to exit 0.
  rm(idxCK)
  const rCK3b = checkCK()
  await check('CK3b a missing REQUIRED docs/index.json is MISSING and fails the check (exit 1)',
    rCK3b.Code === 1 && /\[check\] MISSING\s+docs\/index\.json \(required surface not present\)/i.test(rCK3b.Out), rCK3b.Out)
  await check('CK3b the summary line words the failing count as "differ or are missing"',
    /differ or are missing/i.test(rCK3b.Out), rCK3b.Out)
  buildCK() // restores index.json

  // CK4: a core.autocrlf checkout, with paired CRLF line endings and otherwise identical bytes, is
  // not drift. Mutation anchor: removing the CR normalization on the check path flips this to DRIFT.
  const indexMdCK = j(docsCK, 'INDEX.md')
  const indexMdText = rd(indexMdCK)
  writeFileSync(indexMdCK, indexMdText.replace(/\n/g, '\r\n'))
  const rCK4 = checkCK()
  await check('CK4 a CRLF checkout of a generated surface is tolerated (not DRIFT)',
    rCK4.Code === 0 && !/DRIFT/i.test(rCK4.Out), rCK4.Out)
  writeFileSync(indexMdCK, indexMdText)

  // CK4b: a lone 0x0D, appended at the end of the file with no 0x0A after it, must also fold. The
  // ADR 0033 rule of init.mjs and manifest-gate.mjs drops every 0x0D, paired or not, and the check
  // matches it. Mutation anchor: a pair-only fold leaves this trailing byte in place and flips the
  // case to DRIFT.
  const indexMdBytesCK = readFileSync(indexMdCK)
  writeFileSync(indexMdCK, Buffer.concat([indexMdBytesCK, Buffer.from([0x0d])]))
  const rCK4b = checkCK()
  await check('CK4b a lone (unpaired) trailing CR in a generated surface is still folded, not DRIFT',
    rCK4b.Code === 0 && !/DRIFT/i.test(rCK4b.Out), rCK4b.Out)
  writeFileSync(indexMdCK, indexMdBytesCK)

  // CK5: --check together with --customer is refused, because docs/customer.html embeds the current
  // date and can never be byte-checked. The exit is 2, distinct from drift's exit 1.
  const rCK5 = nodeRun([j(docsCK, 'build_docs.mjs'), '--check', '--customer'])
  await check('CK5 --check --customer is refused with exit 2 (not 1 — 1 means drift)',
    rCK5.Code === 2 && /customer/i.test(rCK5.Out), rCK5.Out)

  // CK7: a duplicate ADR id makes the shared assembly, assemble(), which the build path also uses,
  // refuse before any surface comparison. The verdict is REFUSED (exit 2), never DRIFT. Regenerating
  // cannot fix the corpus defect, so a caller that reads exit 1 as "rebuild and re-run" must not
  // loop on it. Mutation anchor: letting the SystemExit of assemble() propagate uncaught would exit 1
  // with a raw Korean message on stderr instead of this ASCII exit-2 report.
  writeCKDoc('adr/0002-rival.md', '---\nid: "0001"\ntype: adr\ntitle: "rival"\nstatus: proposed\n---\n# rival\n')
  const rCK7 = checkCK()
  const ck7Ascii = [...Buffer.from(rCK7.Out, 'utf8')].every((b) => b < 0x80)
  await check('CK7 a duplicate id makes the assembly refuse: exit 2, REFUSED + builder line, pure ASCII stdout',
    rCK7.Code === 2 && /\[check\] REFUSED/i.test(rCK7.Out) && /\[check\]\s+builder:/i.test(rCK7.Out) && ck7Ascii, rCK7.Out)
  rm(j(docsCK, 'adr/0002-rival.md'))

  // CK9: argument handling. An unknown argument is refused with exit 2 before anything is written.
  // index.json is removed first, so a build that ran past the typo would recreate it. A malformed or
  // second date, and a --version without a value, are refused the same way.
  rm(idxCK)
  const rCK9 = nodeRun([j(docsCK, 'build_docs.mjs'), '--chek'])
  await check('CK9 an unknown flag (--chek) exits 2, names it and writes nothing',
    rCK9.Code === 2 && /--chek/i.test(rCK9.Out) && !existsSync(idxCK), `exit=${rCK9.Code}: ${rCK9.Out}`)
  const ck9Bad = []
  for (const ck9Args of [['2026-1-1'], ['2026-01-01', '2026-01-02'], ['--version'], ['--version', '--check']]) {
    const o = nodeRun([j(docsCK, 'build_docs.mjs'), ...ck9Args])
    if (o.Code !== 2 || existsSync(idxCK)) ck9Bad.push(`${ck9Args.join(' ')}: exit=${o.Code} ${o.Out}`)
  }
  await check('CK9 a malformed date, a second date and a --version without a value each exit 2 and write nothing',
    ck9Bad.length === 0, ck9Bad.join('\n'))
  // CK9 control and restore: the date that an older wrapper passes is accepted and ignored, as a full build.
  const rCK9d = nodeRun([j(docsCK, 'build_docs.mjs'), '2026-01-01'])
  await check('CK9 a single YYYY-MM-DD argument still builds (exit 0, index.json written)',
    rCK9d.Code === 0 && existsSync(idxCK), rCK9d.Out)

  // CK10: a bare integer in related_spec (D8) must not crash the shared assembly. The fixture index
  // is stale for the new ADR, so a clean assembly reports DRIFT (exit 1). A crash would show as
  // REFUSED with a TypeError (exit 2).
  writeCKDoc('adr/0003-rel.md', '---\nid: "0003"\ntype: adr\ntitle: "rel"\nstatus: accepted\nrelated_spec: [10]\n---\n# rel\n')
  const rCK10 = checkCK()
  await check('CK10 related_spec: [10] assembles (DRIFT against the stale index, no REFUSED, no TypeError)',
    rCK10.Code === 1 && /\[check\] DRIFT/i.test(rCK10.Out) && !/REFUSED|TypeError|Traceback/i.test(rCK10.Out), rCK10.Out)
  rm(j(docsCK, 'adr/0003-rel.md'))

  // CK8: an empty corpus, with no .md that has frontmatter in adr/ or spec/, is the same REFUSED
  // class as CK7: exit 2, ASCII only, never DRIFT. A caller must not try to fix it by re-running a
  // regeneration that produced nothing to compare.
  renameSync(j(docsCK, 'adr/0001-a.md'), j(docsCK, 'adr/0001-a.md.bak'))
  const rCK8 = checkCK()
  const ck8Ascii = [...Buffer.from(rCK8.Out, 'utf8')].every((b) => b < 0x80)
  await check('CK8 an empty corpus makes the assembly refuse: exit 2, REFUSED, pure ASCII stdout',
    rCK8.Code === 2 && /\[check\] REFUSED/i.test(rCK8.Out) && ck8Ascii, rCK8.Out)
  renameSync(j(docsCK, 'adr/0001-a.md.bak'), j(docsCK, 'adr/0001-a.md'))
  buildCK() // restores a clean build after the empty-corpus fixture

  // CK6: the check_docs.mjs wrapper. No args runs the check, a flag is a usage refusal, and path
  // arguments are triggers that run the same full check (ADR 0094). The docs groups declare it
  // `files: true`, so pre-commit runs it on a staged ADR or spec.
  // Mutation anchor: a wrapper that treats a path as a refusal, reads only argv[1], or lets a path
  // narrow or skip the check turns CK6d, CK6e and CK6f red. CK6f is the multi-path shape that the
  // hook sends, where a flag after a path must still refuse.
  copyFileSync(checkDocsTemplate, j(docsCK, 'check_docs.mjs'))
  const wrapCK = (...a) => nodeRun([j(docsCK, 'check_docs.mjs'), ...a])
  const rCK6a = wrapCK()
  await check('CK6 wrapper, clean fixture, no args: exit 0 with the [check] OK line',
    rCK6a.Code === 0 && /\[check\] OK/i.test(rCK6a.Out), rCK6a.Out)
  appendFileSync(idxCK, 'x')
  const rCK6b = wrapCK()
  await check('CK6 wrapper on the drifted fixture: exit 1', rCK6b.Code === 1, rCK6b.Out)
  buildCK()
  const rCK6c = wrapCK('--write')
  await check('CK6 wrapper with a flag: exit 2 (usage refusal — the check is the only mode)', rCK6c.Code === 2, rCK6c.Out)
  const rCK6d = wrapCK('docs/adr/0001-a.md')
  await check('CK6 wrapper with a path argument, clean fixture: exit 0 with the [check] OK line (a trigger, not a refusal)',
    rCK6d.Code === 0 && /\[check\] OK/i.test(rCK6d.Out), rCK6d.Out)
  appendFileSync(idxCK, 'x')
  const rCK6e = wrapCK('docs/adr/0001-a.md')
  await check('CK6 wrapper with a path argument on the drifted fixture: exit 1 (the path does not narrow the check)',
    rCK6e.Code === 1, rCK6e.Out)
  const rCK6f = wrapCK('docs/adr/0001-a.md', 'docs/spec/0001-s.md', 'docs/index.json')
  await check('CK6 wrapper with the multi-path list pre-commit sends, drifted fixture: exit 1', rCK6f.Code === 1, rCK6f.Out)
  buildCK()
  const rCK6g = wrapCK('docs/adr/0001-a.md', 'docs/spec/0001-s.md')
  await check('CK6 wrapper with several paths, clean fixture: exit 0 with the [check] OK line',
    rCK6g.Code === 0 && /\[check\] OK/i.test(rCK6g.Out), rCK6g.Out)
  const rCK6h = wrapCK('docs/adr/0001-a.md', '--write')
  await check('CK6 wrapper with a flag after a path: exit 2 (every argument is inspected, not argv[1])',
    rCK6h.Code === 2, rCK6h.Out)

  // --- SL: the STE-lite gate (ADR 0128). check_docs.mjs with path arguments reads each passed spec
  // and new ADR against HEAD, selects the changed sections, and checks R5 (sentence length) and R3
  // (claims in parentheses). The fixture is a git repo with the vendored harness_config.mjs,
  // because the gate takes its diff through git_run() and its mode through load(). Each case edits
  // the committed tree, runs the gate from the fixture root with the relative paths that pre-commit
  // sends, and resets.
  // Mutation anchors: a gate that checks only the changed lines turns SL3 red, because the old long
  // sentence must be named. A gate that checks a records section turns SL1 and SL4 red. A fence
  // reader that takes an inline ```` ```diff ```` span for a fence loses the headings after §1 and
  // turns SL3 red. A gate that blocks without the declaration turns SL7 red.
  const repoSL = j(fx, 'repo-ste')
  const docsSL = j(repoSL, 'docs')
  mk(j(docsSL, 'adr'), j(docsSL, 'spec'), j(repoSL, 'scripts/harness'))
  copyFileSync(builderTemplate, j(docsSL, 'build_docs.mjs'))
  copyFileSync(checkDocsTemplate, j(docsSL, 'check_docs.mjs'))
  copyFileSync(harnessConfigSrc, j(repoSL, 'scripts/harness/harness_config.mjs'))
  copyFileSync(harnessGitSrc, j(repoSL, 'scripts/harness/harness_git.mjs'))
  const long = 'This sentence is deliberately long so that it runs past the limit of twenty five words that the rule sets for every descriptive sentence in a spec.'
  // The base spec holds one unchanged placeholder in section 2 (ADR 0208), so SL18 can prove that the
  // check reads changed lines only. U+2026, U+2014 and the curly quotes are built, never typed,
  // because a gate that scans this file would read a typed one as content of the file.
  const dots = String.fromCharCode(0x2026)
  const em = String.fromCharCode(0x2014)
  const lq = String.fromCharCode(0x201c)
  const rq = String.fromCharCode(0x201d)
  // The inline span on line 14 is two backticks around a three-backtick "diff" word. It is an inline span, not a fence.
  const slSpec = [
    '---', 'id: "0001"', 'type: spec', 'title: "s"', 'status: active', '---',
    '# SPEC 0001. S',
    '',
    '## 1. Clean',
    '',
    'A short sentence stands here.',
    '',
    '- An item with an inline span:',
    '   `` ```diff `` is not a fence.',
    '',
    '## 2. Old',
    '',
    'Old short sentence.',
    '',
    long,
    '',
    `Old skeleton <none | ${dots}> stays.`,
    '',
    '## 3. Change notes',
    '',
    `- ${long}`,
    '',
    '## 4. Verbatim',
    '',
    'A short line.',
    '',
    '<!-- ste-lite: verbatim -->',
    long,
    '',
    '## 5. Table',
    '',
    '| Date | Plugin | Notes |',
    '|---|---|---|',
    '| d1 | 0.1.0 | an old row |',
    '',
    '| d0 | 0.0.9 | older group |',
  ].join('\n')
  const writeSL = (rel, body) => wr(j(repoSL, rel), body)
  // Every fixture git call pins core.autocrlf=false, so a checkout rewrites no line ending.
  const slGit = (...args) => git_run(repoSL, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args])
  const checkSL = (...args) => nodeRun(['docs/check_docs.mjs', ...args], { cwd: repoSL })
  const resetSL = () => {
    slGit('checkout', '--', '.')
    slGit('clean', '-fdq', '--', 'docs')
    rm(j(repoSL, '.harness.json'))
    if (existsSync(j(repoSL, '.harness.json'))) throw new Error('SL fixture: .harness.json survived the reset')
  }
  writeSL('docs/spec/0001-s.md', `${slSpec}\n`)
  writeSL('docs/adr/0001-a.md', '---\nid: "0001"\ntype: adr\ntitle: "a"\nstatus: accepted\n---\n# 0001. A\n\nShort.\n')
  git_run(repoSL, ['init', '-q'])
  nodeRun([j(docsSL, 'build_docs.mjs')])
  rm(j(docsSL, 'docs.html')); rm(j(docsSL, 'docs.artifact.html'))
  writeSL('.gitignore', 'docs/docs.html\ndocs/docs.artifact.html\n__pycache__/\n')
  // guide.md sits outside docs/ for the docs.ste_files cases (ADR 0237). Its section 2 holds an old R3 claim and a declared R7 word.
  const guideBase = '# Guide\n\n## 1. Clean\n\nA short sentence stands here.\n\n## 2. Old\n\nOld text with via inside.\n\nOld claim (a parenthesized claim here) stays.\n'
  writeSL('guide.md', guideBase)
  slGit('add', '-A')
  slGit('commit', '-qm', 'base')
  const specSL = j(repoSL, 'docs/spec/0001-s.md')
  const guideSL = j(repoSL, 'guide.md')
  const editGuide = (find, replace) => {
    const g = rd(guideSL)
    if (!g.includes(find)) throw new Error(`SL fixture: '${find}' not found in guide.md`)
    writeFileSync(guideSL, replaceAll(g, find, replace))
  }
  const editSL = (find, replace) => {
    const t = rd(specSL)
    if (!t.includes(find)) throw new Error(`SL fixture: '${find}' not found`)
    writeFileSync(specSL, replaceAll(t, find, replace))
  }

  // SL1: a short new sentence in §1 passes, and the change notes are a records section, which is not checked.
  editSL('A short sentence stands here.', 'A short sentence stands here.\nAnother short one.')
  editSL('## 3. Change notes\n\n', '## 3. Change notes\n\n- A short new note.\n')
  const rSL1 = checkSL('docs/spec/0001-s.md')
  await check('SL1 a clean section passes and the records section is not checked (exit 0)',
    rSL1.Code === 0 && /\[ste-lite\] OK - 1 section/i.test(rSL1.Out) && /3\. Change notes \(records, not checked\)/i.test(rSL1.Out), rSL1.Out)
  resetSL()

  // SL2: a long sentence, a 21-word numbered step and a claim in parentheses in a changed section.
  editSL('A short sentence stands here.', `A short sentence stands here (which is a claim).\n\n${long}\n\n1. Run this numbered step that has exactly twenty one words so it passes the descriptive limit but fails the step limit.`)
  const rSL2 = checkSL('docs/spec/0001-s.md')
  await check('SL2 R5 sentence, R5 step (> 20) and R3 claim are each reported',
    /R5 docs\/spec\/0001-s\.md:\d+ 27 words > 25/i.test(rSL2.Out) && /R5 docs\/spec\/0001-s\.md:\d+ 21 words > 20/i.test(rSL2.Out)
    && /R3 docs\/spec\/0001-s\.md:\d+ claim in parentheses: "\(which is a claim\)"/i.test(rSL2.Out), rSL2.Out)
  // SL7: with no declaration the same findings are advice, with exit 0 and the line that names the key.
  await check('SL7 undeclared: ADVISORY, exit 0, the docs.ste_lite line printed',
    rSL2.Code === 0 && /\[ste-lite\] ADVISORY - 3 finding/i.test(rSL2.Out) && /ste_lite.: true/i.test(rSL2.Out), rSL2.Out)
  // SL8: with the declaration the same tree blocks with exit 1.
  writeSL('.harness.json', '{"docs": {"ste_lite": true}}')
  const rSL8 = checkSL('docs/spec/0001-s.md')
  await check('SL8 declared docs.ste_lite: true: FAIL, exit 1',
    rSL8.Code === 1 && /\[ste-lite\] FAIL - 3 finding/i.test(rSL8.Out), rSL8.Out)
  resetSL()

  // SL3: a short edit in §2 selects the whole section, so its old long sentence fails (line 20).
  editSL('Old short sentence.', 'Old short sentence, edited.')
  const rSL3 = checkSL('docs/spec/0001-s.md')
  await check('SL3 a changed section is checked whole: the old long sentence on line 20 is named',
    /2\. Old \(whole\)/i.test(rSL3.Out) && /R5 docs\/spec\/0001-s\.md:20 27 words/i.test(rSL3.Out) && !/1\. Clean/i.test(rSL3.Out), rSL3.Out)
  resetSL()

  // SL4: a records section is not checked at all, so a long new row passes too.
  editSL('## 3. Change notes\n\n', `## 3. Change notes\n\n- ${long}\n`)
  const rSL4 = checkSL('docs/spec/0001-s.md')
  await check('SL4 records section: a new long row is not checked (exit 0, no finding)',
    rSL4.Code === 0 && !/ R5 /i.test(rSL4.Out) && /records, not checked/i.test(rSL4.Out) && /no checked section/i.test(rSL4.Out), rSL4.Out)
  resetSL()

  // SL5: an edit in §4 checks it whole, and the verbatim block under the marker is exempt.
  editSL('A short line.', 'A short line, edited.')
  const rSL5 = checkSL('docs/spec/0001-s.md')
  await check('SL5 a verbatim block is exempt from the whole-section check',
    rSL5.Code === 0 && /4\. Verbatim \(whole\)/i.test(rSL5.Out) && /\[ste-lite\] OK - 1 section/i.test(rSL5.Out), rSL5.Out)
  resetSL()

  // SL6: a new ADR is checked whole; a changed accepted ADR is skipped (append-only).
  writeSL('docs/adr/0002-b.md', `---\nid: "0002"\ntype: adr\ntitle: "b"\nstatus: accepted\n---\n# 0002. B\n\n${long}\n\n## Options considered\n\n| Option | Verdict |\n|---|---|\n| A | Adopted |\n| B | Rejected |\n`)
  appendFileSync(j(docsSL, 'adr/0001-a.md'), `\n${long}`)
  const rSL6 = checkSL('docs/adr/0001-a.md', 'docs/adr/0002-b.md')
  await check('SL6 a new ADR is checked whole and a changed ADR is skipped',
    /R5 docs\/adr\/0002-b\.md:9 /i.test(rSL6.Out) && !/0001-a\.md/i.test(rSL6.Out) && /ADVISORY - 1 finding/i.test(rSL6.Out), rSL6.Out)
  resetSL()

  // SL9: a table whose row groups are blank-separated, as spec 0014 §7 writes them, in a checked
  // section. A new group's first row is a data row, not a header. The reference forms
  // `(record run #N, manifest X.Y.Z)` pass R3, and a real claim in that row is flagged.
  editSL('| d0 | 0.0.9 | older group |', '| d2 | 0.2.0 (record run #3, manifest 0.2.0) | short note |\n\n| d0 | 0.0.9 | older group |')
  const rSL9 = checkSL('docs/spec/0001-s.md')
  await check('SL9 a new table group in the eval-row reference form passes R3',
    rSL9.Code === 0 && /5\. Table \(whole\)/i.test(rSL9.Out) && /\[ste-lite\] OK - 1 section/i.test(rSL9.Out), rSL9.Out)
  resetSL()
  editSL('| d0 | 0.0.9 | older group |', '| d3 | 0.3.0 | a note (that hides a claim) |\n\n| d0 | 0.0.9 | older group |')
  const rSL9b = checkSL('docs/spec/0001-s.md')
  await check('SL9b the first row of a new blank-separated group is checked: its claim is flagged',
    /R3 docs\/spec\/0001-s\.md:\d+ claim in parentheses: "\(that hides a claim\)"/i.test(rSL9b.Out) && /ADVISORY - 1 finding/i.test(rSL9b.Out), rSL9b.Out)
  resetSL()

  // SL10: removing a whole section selects nothing, and a new section appended with its leading
  // blank line selects only itself, never the untouched section above it.
  {
    const t = rd(specSL)
    const cut = t.indexOf('## 4. Verbatim')
    const end = t.indexOf('## 5. Table')
    writeFileSync(specSL, t.slice(0, cut) + t.slice(end))
  }
  const rSL10 = checkSL('docs/spec/0001-s.md')
  await check('SL10 a deleted whole section selects no section',
    rSL10.Code === 0 && /no checked section/i.test(rSL10.Out) && !/3\. Change notes|5\. Table/i.test(rSL10.Out), rSL10.Out)
  resetSL()
  appendFileSync(specSL, '\n## 6. New\n\nA new short section.\n')
  const rSL10b = checkSL('docs/spec/0001-s.md')
  await check('SL10b an appended section selects only itself, not the table above it',
    /6\. New \(whole\)/i.test(rSL10b.Out) && !/5\. Table/i.test(rSL10b.Out) && /OK - 1 section/i.test(rSL10b.Out), rSL10b.Out)
  resetSL()

  // SL11: a .harness.json below the git top level. The HEAD lookup must read the path from that root
  // (`HEAD:./<rel>`), or every spec reads as new and is checked whole.
  const repoN = j(fx, 'repo-ste-nested')
  const svc = j(repoN, 'svc')
  mk(j(svc, 'docs/spec'), j(svc, 'docs/adr'), j(svc, 'scripts/harness'))
  copyFileSync(builderTemplate, j(svc, 'docs/build_docs.mjs'))
  copyFileSync(checkDocsTemplate, j(svc, 'docs/check_docs.mjs'))
  copyFileSync(harnessConfigSrc, j(svc, 'scripts/harness/harness_config.mjs'))
  copyFileSync(harnessGitSrc, j(svc, 'scripts/harness/harness_git.mjs'))
  copyFileSync(specSL, j(svc, 'docs/spec/0001-s.md'))
  wr(j(svc, '.harness.json'), '{"docs": {"ste_lite": true}}')
  wr(j(repoN, '.gitignore'), '__pycache__/\nsvc/docs/docs.html\nsvc/docs/docs.artifact.html\n')
  git_run(repoN, ['init', '-q'])
  nodeRun([j(svc, 'docs/build_docs.mjs')])
  rm(j(svc, 'docs/docs.html')); rm(j(svc, 'docs/docs.artifact.html'))
  git_run(repoN, ['-c', 'core.autocrlf=false', 'add', '-A'])
  git_run(repoN, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'])
  const specN = j(svc, 'docs/spec/0001-s.md')
  writeFileSync(specN, replaceAll(rd(specN), 'A short sentence stands here.', 'A short sentence stands here, edited.'))
  const rSL11 = nodeRun(['docs/check_docs.mjs', 'docs/spec/0001-s.md'], { cwd: svc })
  await check('SL11 a .harness.json below the git root: only the changed section is checked (exit 0)',
    rSL11.Code === 0 && /1\. Clean \(whole\)/i.test(rSL11.Out) && !/2\. Old/i.test(rSL11.Out) && /OK - 1 section/i.test(rSL11.Out), rSL11.Out)

  // SL12: advisory mode never blocks. A missing harness_config.mjs prints NOT CHECKED and exits 0,
  // and a non-boolean docs.ste_lite prints a WARN line and stays advisory.
  editSL('Old short sentence.', 'Old short sentence, edited.')
  const hcSL = j(repoSL, 'scripts/harness/harness_config.mjs')
  renameSync(hcSL, `${hcSL}.off`)
  let rSL12
  try { rSL12 = checkSL('docs/spec/0001-s.md') } finally { renameSync(`${hcSL}.off`, hcSL) }
  // The placeholder check never passes a file unread (ADR 0208). With no harness_config.mjs it reads
  // every line, so the base fixture's unchanged placeholder fails the run.
  await check('SL12 harness_config.mjs missing: STE-lite NOT CHECKED; the placeholder check reads the whole file and fails on the unchanged base placeholder (exit 1)',
    rSL12.Code === 1 && /\[ste-lite\] NOT CHECKED/i.test(rSL12.Out) && /\[placeholder\] WHOLE FILES \(scripts\/harness\/harness_config\.mjs unusable/i.test(rSL12.Out)
    && /\[placeholder\] FAIL - 1 finding/i.test(rSL12.Out) && !/\[placeholder\] NOT CHECKED/i.test(rSL12.Out), rSL12.Out)
  writeSL('.harness.json', '{"docs": {"ste_lite": "true"}}')
  const rSL12b = checkSL('docs/spec/0001-s.md')
  await check('SL12b a string docs.ste_lite: WARN line, advisory, exit 0',
    rSL12b.Code === 0 && /\[ste-lite\] WARN docs\.ste_lite/i.test(rSL12b.Out) && /ADVISORY/i.test(rSL12b.Out), rSL12b.Out)
  resetSL()

  // SL12c to SL12e: a reader file that exists but fails to load is a broken toolchain (spec 0001 §4.3).
  editSL('Old short sentence.', 'Old short sentence, edited.')
  writeSL('notes.md', '# Notes\n\nA note.\n')
  const hgSL = j(repoSL, 'scripts/harness/harness_git.mjs')
  renameSync(hgSL, `${hgSL}.off`)
  let rSL12c
  let rSL12d
  try { rSL12c = checkSL('docs/spec/0001-s.md'); rSL12d = checkSL('notes.md') } finally { renameSync(`${hgSL}.off`, hgSL) }
  await check('SL12c harness_git.mjs missing beside harness_config.mjs: a passed spec gets a framed STE-lite FAIL, no stack trace (exit 1)',
    rSL12c.Code === 1 && /\[ste-lite\] FAIL \(scripts\/harness\/harness_config\.mjs failed to load: ModuleNotFoundError/i.test(rSL12c.Out)
    && !/\[ste-lite\] NOT CHECKED/i.test(rSL12c.Out) && !/^\s+at /m.test(rSL12c.Out) && /\[placeholder\] WHOLE FILES/i.test(rSL12c.Out), rSL12c.Out)
  await check('SL12d harness_git.mjs missing beside harness_config.mjs: a passed non-docs .md gets NOT CHECKED and does not block (exit 0)',
    rSL12d.Code === 0 && /\[ste-lite\] NOT CHECKED \(scripts\/harness\/harness_config\.mjs failed to load: ModuleNotFoundError/i.test(rSL12d.Out)
    && !/^\s+at /m.test(rSL12d.Out), rSL12d.Out)
  rm(j(repoSL, 'notes.md'))
  const hcSLe = j(repoSL, 'scripts/harness/harness_config.mjs')
  writeFileSync(hcSLe, "throw { name: 'X\\n[ste-lite] OK - forged' }\n")
  let rSL12e
  try { rSL12e = checkSL('docs/spec/0001-s.md') } finally { copyFileSync(harnessConfigSrc, hcSLe) }
  await check('SL12e a thrown name with a newline prints escaped on the FAIL line and forges no OK line (exit 1)',
    rSL12e.Code === 1 && /\[ste-lite\] FAIL \(scripts\/harness\/harness_config\.mjs failed to load: X\\x0a\[ste-lite\] OK - forged - re-run/.test(rSL12e.Out)
    && !/^\[ste-lite\] OK/m.test(rSL12e.Out) && /\[placeholder\] WHOLE FILES \(scripts\/harness\/harness_config\.mjs unusable: X\\x0a\[ste-lite\]/.test(rSL12e.Out), rSL12e.Out)
  resetSL()

  // SL13 (ADR 0170): R8 flags an em dash, a joining semicolon, "(s)" and "and/or" in a changed
  // section, one line per kind. A semicolon inside parentheses (an R3 reference list), an entity's
  // semicolon, an em dash in a code span, a table cell that holds only an em dash, and a bare URL
  // pass. The em dash entity is flagged. The forms sit in table rows of their own, because a unit
  // reports each kind once, and in the paragraph a miscount would hide. Mutation anchors: a gate
  // that counts any passing form, or misses the entity, turns the count of 5 red.
  editSL('A short sentence stands here.', `A short sentence ${em} with a dash. One clause; another clause. Each file(s) and/or dir passes.`)
  editSL('| d1 | 0.1.0 | an old row |', `| d1 | 0.1.0 | an old row |\n| d4 | ${em} | a \`code ${em} span\` row (ADR 1; spec 2) &amp; more |\n| d5 | https://h/a;b/and/or | y &mdash; z |`)
  const rSL13 = checkSL('docs/spec/0001-s.md')
  await check('SL13 R8 reports each mark kind once; the reference list, code span and lone em dash cell pass',
    /R8 docs\/spec\/0001-s\.md:\d+ em dash/i.test(rSL13.Out) && /R8 docs\/spec\/0001-s\.md:\d+ joining semicolon/i.test(rSL13.Out)
    && /R8 docs\/spec\/0001-s\.md:\d+ "\(s\)"/i.test(rSL13.Out) && /R8 docs\/spec\/0001-s\.md:\d+ "and\/or"/i.test(rSL13.Out)
    && /R8 docs\/spec\/0001-s\.md:\d+ em dash: "y &mdash; z/i.test(rSL13.Out) && /5\. Table \(whole\)/i.test(rSL13.Out)
    && /ADVISORY - 5 finding/i.test(rSL13.Out), rSL13.Out)
  resetSL()

  // SL13b (ADR 0188): a cell that holds only an em dash entity is the empty-cell mark too, and a
  // semicolon inside a closed bracket pair or closed double quotes (straight or curly) joins no
  // clauses. An unclosed inch mark guards nothing (d8), and it never pairs with a later real quote
  // (d9). Only the innermost bracket pair guards, so the outer semicolon of d10 reports. Mutation
  // anchors: an exemption for U+2014 alone adds two findings (d6), a guard that skips an unclosed
  // quote drops d8, a quote that opens after a digit drops d9, and a greedy bracket pattern drops d10.
  editSL('| d1 | 0.1.0 | an old row |', `| d1 | 0.1.0 | an old row |\n| d6 | &mdash; | &#8212; |\n| d7 | "one; two" and [a; b] and ${lq}c; d${rq} | x |\n| d8 | a 3" mark; then more | y |\n| d9 | a 3" pipe; then run "make" | y |\n| d10 | [a; [b] c] | y |`)
  const rSL13b = checkSL('docs/spec/0001-s.md')
  await check('SL13b entity em dash cells and closed bracket or quote semicolons pass; an inch mark and an outer bracket do not guard',
    /R8 docs\/spec\/0001-s\.md:\d+ joining semicolon: "a 3" mark/i.test(rSL13b.Out) && /R8 docs\/spec\/0001-s\.md:\d+ joining semicolon: "a 3" pipe/i.test(rSL13b.Out)
    && /R8 docs\/spec\/0001-s\.md:\d+ joining semicolon: "\[a; \[b\] c\]/i.test(rSL13b.Out) && /ADVISORY - 3 finding/i.test(rSL13b.Out), rSL13b.Out)
  resetSL()

  // SL14 (ADR 0170): a declared word is an R7 finding with its replacement, in any case. Inside a
  // code span or a longer word it passes, and the second paragraph would add a finding otherwise.
  // SL14b: a bad map warns and drops the whole map, a string docs.ste_marks warns, and both stay advisory.
  editSL('A short sentence stands here.', 'A short sentence stands here VIA a path. The `via` span passes.\n\nA viable trivia line.')
  writeSL('.harness.json', '{"docs": {"ste_words": {"via": "through"}}}')
  const rSL14 = checkSL('docs/spec/0001-s.md')
  await check('SL14 a declared word is flagged with its replacement; a code span passes',
    /R7 docs\/spec\/0001-s\.md:\d+ "via" -> "through"/i.test(rSL14.Out) && /ADVISORY - 1 finding/i.test(rSL14.Out), rSL14.Out)
  writeSL('.harness.json', '{"docs": {"ste_marks": "true", "ste_words": {"via": "through", "e.g.": 3}}}')
  const rSL14b = checkSL('docs/spec/0001-s.md')
  await check('SL14b a bad word map and a string docs.ste_marks: two WARN lines, no R7 finding, exit 0',
    rSL14b.Code === 0 && /\[ste-lite\] WARN docs\.ste_words/i.test(rSL14b.Out) && /\[ste-lite\] WARN docs\.ste_marks/i.test(rSL14b.Out)
    && !/R7 docs\//i.test(rSL14b.Out) && /OK - 1 section/i.test(rSL14b.Out), rSL14b.Out)
  resetSL()

  // SL14c: a "//" key in docs.ste_words is a comment, as in the other sections, never a word to
  // flag. Mutation anchor: reading the key as a word adds an R7 finding on the " // " in the text.
  editSL('A short sentence stands here.', 'A short sentence // stands here VIA a path.')
  writeSL('.harness.json', '{"docs": {"ste_words": {"//": "a comment key", "via": "through"}}}')
  const rSL14c = checkSL('docs/spec/0001-s.md')
  await check('SL14c a "//" key in docs.ste_words is a comment: one R7 finding, for "via" only',
    /R7 docs\/spec\/0001-s\.md:\d+ "via" -> "through"/i.test(rSL14c.Out) && !/R7 [^\r\n]*"\/\/"/i.test(rSL14c.Out) && /ADVISORY - 1 finding/i.test(rSL14c.Out), rSL14c.Out)
  resetSL()

  // SL15 (ADR 0170): a new ADR with one option, and one with no options heading, are each a finding.
  // SL6 above is the passing control: its ADR records two options and reports only its R5 line.
  // The two-item "Adoption plan" section above the options must not count. The heading match takes
  // whole words, so a substring match would pass ADR 0003 here.
  writeSL('docs/adr/0003-c.md', '---\nid: "0003"\ntype: adr\ntitle: "c"\nstatus: accepted\n---\n# 0003. C\n\nShort.\n\n## Adoption plan\n\n- Step one.\n- Step two.\n\n## Options\n\n| Option | Verdict |\n|---|---|\n| A | Adopted |\n')
  writeSL('docs/adr/0004-d.md', '---\nid: "0004"\ntype: adr\ntitle: "d"\nstatus: accepted\n---\n# 0004. D\n\nShort.\n')
  const rSL15 = checkSL('docs/adr/0003-c.md', 'docs/adr/0004-d.md')
  await check('SL15 one option and no options heading are each an OPT finding',
    /OPT docs\/adr\/0003-c\.md:\d+ 1 option, fewer than 2/i.test(rSL15.Out) && /OPT docs\/adr\/0004-d\.md:1 no options section/i.test(rSL15.Out)
    && /ADVISORY - 2 finding/i.test(rSL15.Out), rSL15.Out)
  resetSL()

  // SL16 (ADR 0170): two keys. The scaffold seed declares docs.ste_lite only, so there an R8 finding
  // stays advice, with exit 0 and the ste_marks line printed, and an R5 finding still blocks.
  // docs.ste_marks alone blocks R8 and leaves R5 as advice. Mutation anchor: one shared switch turns SL16 red.
  editSL('A short sentence stands here.', `A short sentence ${em} with a dash.`)
  writeSL('.harness.json', '{"docs": {"ste_lite": true}}')
  const rSL16 = checkSL('docs/spec/0001-s.md')
  await check('SL16 docs.ste_lite alone: an R8 finding is advice (exit 0) and names docs.ste_marks',
    rSL16.Code === 0 && /ADVISORY - 1 finding/i.test(rSL16.Out) && /ste_marks.: true/i.test(rSL16.Out) && !/ste_lite.: true/i.test(rSL16.Out), rSL16.Out)
  writeSL('.harness.json', '{"docs": {"ste_marks": true}}')
  const rSL16b = checkSL('docs/spec/0001-s.md')
  await check('SL16b docs.ste_marks: true: the R8 finding blocks (FAIL, exit 1)',
    rSL16b.Code === 1 && /\[ste-lite\] FAIL - 1 finding/i.test(rSL16b.Out), rSL16b.Out)
  editSL(`A short sentence ${em} with a dash.`, `A short sentence stands here.\n\n${long}`)
  const rSL16c = checkSL('docs/spec/0001-s.md')
  await check('SL16c docs.ste_marks alone: an R5 finding is advice (exit 0) and names docs.ste_lite',
    rSL16c.Code === 0 && /ADVISORY - 1 finding/i.test(rSL16c.Out) && /ste_lite.: true/i.test(rSL16c.Out), rSL16c.Out)
  editSL('A short sentence stands here.', `A short sentence ${em} with a dash.`)
  writeSL('.harness.json', '{"docs": {"ste_lite": true, "ste_marks": true}}')
  const rSL16d = checkSL('docs/spec/0001-s.md')
  await check('SL16d both keys: an R5 and an R8 finding fail together (FAIL - 2, exit 1, no advisory line)',
    rSL16d.Code === 1 && /\[ste-lite\] FAIL - 2 finding/i.test(rSL16d.Out) && !/advisory:/i.test(rSL16d.Out), rSL16d.Out)
  resetSL()

  // SL17: the corpus seed that harness-init places is a new ADR in a scaffolded repo's first commit,
  // so the gate checks it whole there. It must pass under both keys, or the seed blocks every fresh
  // repo's first commit. The shipped template bytes are checked, with only the id renumbered past
  // the fixture's ADR 0001. The index is rebuilt first, so the exit code is the whole check's
  // verdict, as pre-commit reads it. Mutation anchor: a seed text with findings under R3, R5 or R8
  // turns SL17 red.
  const seedSL = rd(j(here, 'templates/docs/adr/0001-adopt-docs-as-code.md'))
  if (!seedSL.includes('id: "0001"')) throw new Error('SL17 fixture: the seed ADR has no id: "0001" line')
  writeSL('docs/adr/0002-adopt-docs-as-code.md', replaceAll(seedSL, 'id: "0001"', 'id: "0002"'))
  writeSL('.harness.json', '{"docs": {"ste_lite": true, "ste_marks": true}}')
  nodeRun([j(docsSL, 'build_docs.mjs')])
  rm(j(docsSL, 'docs.html')); rm(j(docsSL, 'docs.artifact.html'))
  const rSL17 = checkSL('docs/adr/0002-adopt-docs-as-code.md')
  await check('SL17 the harness-init seed ADR passes R3, R5, R8 and the option count under both keys (exit 0)',
    rSL17.Code === 0 && /\[ste-lite\] OK - \d+ section\(s\) in 1 file\(s\) pass R3, R5, R8 and the ADR option count/i.test(rSL17.Out)
    && !/\[ste-lite\]\s+(R\d|OPT) /i.test(rSL17.Out), rSL17.Out)
  resetSL()

  // SL18 (ADR 0208): the placeholder check reads the same files and changed lines as STE-lite and
  // fails under no key. The base spec holds an unchanged placeholder in section 2, which is never
  // reported. On changed lines a bare `<none | U+2026>` fails. The same span in a code span,
  // `<met | not met>` (accepted, because it holds no U+2026), an HTML comment and a plain tag pass.
  // SL18b: a records section is read, a verbatim block is exempt, and docs.ste_lite: false gates
  // nothing. SL18c: a new ADR is read and a changed accepted ADR is skipped. Mutation anchors: a
  // reader that skips records sections drops SL18b, one that reads code spans or the verbatim block
  // adds a finding to SL18 or SL18b, and one that reads unchanged lines reports two in SL18.
  editSL('A short sentence stands here.', `A short sentence stands here.\nAdd <none | ${dots}> here.\n\nCode \`<none | ${dots}>\` span.\n\nNot placeholders: <met | not met>, <!-- <done | ${dots}> --> and <b>x</b>.`)
  const rSL18 = checkSL('docs/spec/0001-s.md')
  const sl18n = count(rSL18.Out, '[placeholder] docs/spec/')
  await check('SL18 a changed bare placeholder fails with no key (exit 1, one finding on line 12); code span, met-or-not, comment, tag and the unchanged base line pass',
    rSL18.Code === 1 && sl18n === 1 && /\[placeholder\] docs\/spec\/0001-s\.md:12 unfilled skeleton placeholder: "<none \| \\u2026>"/i.test(rSL18.Out)
    && /\[placeholder\] FAIL - 1 finding/i.test(rSL18.Out) && /\[ste-lite\] OK - 1 section/i.test(rSL18.Out), rSL18.Out)
  resetSL()

  writeSL('.harness.json', '{"docs": {"ste_lite": false}}')
  editSL('## 3. Change notes\n\n', '## 3. Change notes\n\n- <judge: t1 1> note.\n')
  editSL(`<!-- ste-lite: verbatim -->\n${long}`, `<!-- ste-lite: verbatim -->\n${long} <none | ${dots}>`)
  const rSL18b = checkSL('docs/spec/0001-s.md')
  const sl18bn = count(rSL18b.Out, '[placeholder] docs/spec/')
  await check('SL18b a records section is read (finding), a verbatim block is exempt, docs.ste_lite: false gates nothing (exit 1)',
    rSL18b.Code === 1 && sl18bn === 1 && /unfilled skeleton placeholder: "<judge: t1 1>"/i.test(rSL18b.Out)
    && /3\. Change notes \(records, not checked\)/i.test(rSL18b.Out) && /\[placeholder\] FAIL - 1 finding/i.test(rSL18b.Out), rSL18b.Out)
  resetSL()

  writeSL('docs/adr/0005-e.md', '---\nid: "0005"\ntype: adr\ntitle: "e"\nstatus: accepted\n---\n# 0005. E\n\n<NO KEY SET: judge from --all>\n')
  appendFileSync(j(docsSL, 'adr/0001-a.md'), `\n<none | ${dots}>`)
  const rSL18c = checkSL('docs/adr/0001-a.md', 'docs/adr/0005-e.md')
  const sl18cn = count(rSL18c.Out, '[placeholder] docs/adr/')
  await check('SL18c a new ADR is read (line 9, NO KEY SET) and a changed accepted ADR is skipped',
    sl18cn === 1 && /\[placeholder\] docs\/adr\/0005-e\.md:9 unfilled skeleton placeholder: "<NO KEY SET: judge from --all>"/i.test(rSL18c.Out)
    && !/0001-a\.md/i.test(rSL18c.Out), rSL18c.Out)
  resetSL()

  // SL19 (ADR 0237): a file that docs.ste_files lists is read like a spec with R3, R5 and R8 only. The
  // same file undeclared is ignored. Mutation anchors: a gate that reads the undeclared file turns
  // SL19b red, one that passes the R7 words turns SL19c red, one that reads a whole file turns SL19c red
  // (section 2 is unchanged in SL19).
  const declSL = (extra = {}) => writeSL('.harness.json', JSON.stringify({ docs: { ste_lite: true, ste_marks: true,
    ste_words: { via: 'through' }, ste_files: ['guide.md'], ...extra } }))
  editGuide('A short sentence stands here.', `A short sentence ${em} with a dash VIA a path.`)
  declSL()
  const rSL19 = checkSL('guide.md')
  await check('SL19 a declared file: an R8 finding in the changed section blocks (FAIL - 1, exit 1); no R7 word finding; the unchanged section 2 is not read',
    rSL19.Code === 1 && /\[ste-lite\] FAIL - 1 finding/i.test(rSL19.Out) && /\[ste-lite\]\s+R8 guide\.md:5 em dash/i.test(rSL19.Out)
    && /guide\.md 1\. Clean \(whole\)/i.test(rSL19.Out) && !/R7 /i.test(rSL19.Out) && !/2\. Old/i.test(rSL19.Out), rSL19.Out)
  writeSL('.harness.json', JSON.stringify({ docs: { ste_lite: true, ste_marks: true, ste_words: { via: 'through' } } }))
  const rSL19b = checkSL('guide.md')
  await check('SL19b the same file undeclared: ignored (exit 0, the no spec or ADR line, the file never named)',
    rSL19b.Code === 0 && /\[ste-lite\] OK - no spec or ADR of this docs tree among the passed paths/i.test(rSL19b.Out) && !/guide\.md/i.test(rSL19b.Out.replace(/\[placeholder\][^\n]*/g, '')), rSL19b.Out)
  resetSL()

  editGuide('Old text with via inside.', 'Old text with via inside, edited.')
  declSL()
  const rSL19c = checkSL('guide.md')
  await check('SL19c a changed section 2 is read whole: the old R3 claim fails and the declared R7 word is not flagged (FAIL - 1, exit 1)',
    rSL19c.Code === 1 && /\[ste-lite\] FAIL - 1 finding/i.test(rSL19c.Out) && /\[ste-lite\]\s+R3 guide\.md:11 claim in parentheses/i.test(rSL19c.Out)
    && !/R7 /i.test(rSL19c.Out) && !/1\. Clean/i.test(rSL19c.Out), rSL19c.Out)
  resetSL()

  editGuide('A short sentence stands here.', 'A short sentence stands here.\n\nAnother short one.')
  editSL('A short sentence stands here.', 'A short sentence stands here.\nAnother short one.')
  declSL()
  const rSL19d = checkSL('guide.md')
  const rSL19d2 = checkSL('guide.md', 'docs/spec/0001-s.md')
  await check('SL19d a clean declared file passes without ", R7 words"; with a spec in the run the summary names R7 words',
    rSL19d.Code === 0 && /\[ste-lite\] OK - 1 section\(s\) in 1 file\(s\) pass R3, R5, R8\r?\n/i.test(rSL19d.Out)
    && rSL19d2.Code === 0 && /\[ste-lite\] OK - 2 section\(s\) in 2 file\(s\) pass R3, R5, R8, R7 words\r?\n/i.test(rSL19d2.Out), rSL19d.Out + rSL19d2.Out)
  resetSL()

  editGuide('A short sentence stands here.', `A short sentence ${em} with a dash.`)
  declSL({ ste_marks: false })
  const rSL19e = checkSL('guide.md')
  await check('SL19e a declared file follows the mode keys: an R8 finding is advice under docs.ste_lite alone (ADVISORY, exit 0)',
    rSL19e.Code === 0 && /\[ste-lite\] ADVISORY - 1 finding/i.test(rSL19e.Out) && /ste_marks.: true/i.test(rSL19e.Out), rSL19e.Out)
  resetSL()

  // SL20 (ADR 0237): docs.ste_files reader. A bad entry drops alone with a WARN line that names its index and
  // never echoes its value; a duplicate and a ./ or backslash spelling read as one entry; a non-array drops the key.
  editGuide('A short sentence stands here.', `A short sentence ${em} with a dash.`)
  declSL({ ste_files: ['guide.md', '../x.md', '/abs.md', 'C:/x.md', 'notes.txt', 3, 'a;b.md', '//guide.md', './guide.md', '.\\guide.md'] })
  const rSL20 = checkSL('guide.md')
  await check('SL20 a bad entry drops with its own WARN line (seven lines, none echoes a value); the valid spellings of guide.md still declare it (FAIL, exit 1)',
    count(rSL20.Out, '[ste-lite] WARN docs.ste_files: entry ') === 7 && !/abs\.md|a;b/i.test(rSL20.Out)
    && rSL20.Code === 1 && /\[ste-lite\]\s+R8 guide\.md:5 em dash/i.test(rSL20.Out) && count(rSL20.Out, 'R8 guide.md') === 1, rSL20.Out)
  declSL({ ste_files: 'guide.md' })
  const rSL20b = checkSL('guide.md')
  await check('SL20b a non-array docs.ste_files warns once and declares nothing (exit 0, the no spec or ADR line)',
    rSL20b.Code === 0 && count(rSL20b.Out, '[ste-lite] WARN docs.ste_files: expected an array') === 1
    && /\[ste-lite\] OK - no spec or ADR of this docs tree among the passed paths/i.test(rSL20b.Out) && !/R8 /i.test(rSL20b.Out), rSL20b.Out)
  resetSL()

  // --- FL: every YAML list shape that a spec uses indexes as the same list --------------------------
  // A builder that reads only the one-line `[a, b]` form leaves a block list as null in index.json
  // and a multi-line flow list as the string "[". verify_map then crashes on the null (TypeError,
  // exit 1) and iterates the "[" into an empty mapping, silently. Each shape is followed by another
  // key, so a parser that swallows past the list's end fails here too. FL3 is the one-line control,
  // and it carries the ']'-in-an-item path that a naive parser truncates.
  const repoFL = j(fx, 'repo-lists')
  const docsFL = docsTree(repoFL)
  const writeFLSpec = (id, lists) => wr(j(docsFL, `spec/${id}-s.md`), `---\nid: "${id}"\ntype: spec\ntitle: "s${id}"\nstatus: active\n${lists}\ntags: [x]\n---\n# ${id}\n`)
  writeFLSpec('0001', 'implements_in:\n  - src/a.py\n  - "src/b.py"   # quoted, commented')
  writeFLSpec('0002', 'implements_in: [\n  "src/a.py",\n  src/b.py,   # trailing comma\n]')
  writeFLSpec('0003', 'implements_in: ["app/api/auth/[...nextauth]/route.ts", "src/c.py"]')
  writeFLSpec('0004', 'implements_in:   # compact block, a comment line between items\n- src/a.py\n\n# between\n- src/b.py')
  // FL6 to FL9 pin the rules that keep a list from swallowing or truncating. FL6: a last item ending
  // in ']' with the list's ']' on the next line. A close rule that stops at the first line ending in
  // ']' would cut it to 'app/[slug'. FL7: the column-0 key guard, for a list left open before the
  // next key and a stray ']' after it. Without the guard `note: kept` is swallowed into the list.
  // FL8: a comment-only value is null, not the comment's text '# TBD'. FL9: a title that starts with
  // '[' and is no list keeps every key after it, because the bracket balance closes it on its own line.
  writeFLSpec('0006', 'implements_in: [\n  src/a.py,\n  app/[slug]\n]')
  writeFLSpec('0007', 'implements_in: [\n  "src/a.py",\nnote: kept\n]')
  writeFLSpec('0008', 'implements_in:   # TBD — nothing owned yet\nsuperseded_by:   # none')
  wr(j(docsFL, 'spec/0009-s.md'), '---\nid: "0009"\ntype: spec\ntitle: [WIP] gate layer\nstatus: draft\nimplements_in: [src/w.py]\ntags: [x]\n---\n# 0009\n')
  // FL11 to FL16: backslash escapes in a double-quoted scalar and the link-scheme filter, on the
  // same build as the list shapes above. 0010 carries a title with \" and \\, a flow list and a block
  // list whose items carry \", and \n, which stays two characters because only \" and \\ are
  // unescaped. It also carries an unterminated `"C:\dir\"`, which keeps its literal reading, and a
  // body whose links use a plain scheme, a tab-split scheme, a leading control character, data: and vbscript:.
  const flTab = '\t'
  const flCtl = String.fromCharCode(1)
  // String.raw keeps every backslash as written.
  const fl10 = String.raw`---
id: "0010"
type: spec
title: "say \"hi\" \\ done"
status: draft
flow: ["a \"b\"", "c"]
blk:
  - "x \"y\" z"   # comment after the item
  - "w"
raw: "a\nb"
tail: "C:\dir\"
tags: [x]
---
# 0010
[js](javascript:x) [tab](java${flTab}script:x) [ctl](${flCtl}javascript:x) [data](data:text/html,x) [vb](VBScript:x) [ok](https://example.com/p#q)`
  wr(j(docsFL, 'spec/0010-s.md'), fl10)
  // The 0001 ADR holds a bare integer in related_spec (D8), which the builder must join as text.
  wr(j(docsFL, 'adr/0001-r.md'), '---\nid: "0001"\ntype: adr\ntitle: "r"\nstatus: accepted\nrelated_spec: [10]\nrelated_adr: [2]\n---\n# 0001\n')
  const rFL = nodeRun([j(docsFL, 'build_docs.mjs')])
  const flCode = rFL.Code
  const flJson = readJson(j(docsFL, 'index.json'))
  const flEntry = (id) => (flJson?.spec ?? []).filter((e) => e.id === id)
  const arr = (v) => (Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]))
  const getFLImpl = (id) => {
    const e = flEntry(id)
    if (e.length !== 1) return '<no entry>'
    const v = e[0].implements_in
    if (v === null || v === undefined) return '<null>'
    if (typeof v === 'string') return `<string '${v}'>`
    return `${arr(v).join(',')} | tags=${arr(e[0].tags).join(',')}`
  }
  const getFLKey = (id, key) => {
    const e = flEntry(id)
    if (e.length !== 1) return '<no entry>'
    if (!Object.hasOwn(e[0], key)) return '<absent>'
    const v = e[0][key]
    if (v === null || v === undefined) return '<null>'
    return String(v)
  }
  await check('FL0 FL the list-shape corpus builds (exit 0)', flCode === 0 && flJson, `exit=${flCode}: ${rFL.Out}`)
  await check('FL1 a block list indexes as the list (was null)', getFLImpl('0001') === 'src/a.py,src/b.py | tags=x', `got: ${getFLImpl('0001')}`)
  await check('FL2 a multi-line flow list indexes as the list (was the string "[")', getFLImpl('0002') === 'src/a.py,src/b.py | tags=x', `got: ${getFLImpl('0002')}`)
  await check('FL3 the one-line form is unchanged, an item carrying [...] included', getFLImpl('0003') === 'app/api/auth/[...nextauth]/route.ts,src/c.py | tags=x', `got: ${getFLImpl('0003')}`)
  await check('FL4 a compact block with a comment head and a comment line between items', getFLImpl('0004') === 'src/a.py,src/b.py | tags=x', `got: ${getFLImpl('0004')}`)
  await check('FL6 a multi-line flow list whose last item ends in ] keeps the item whole', getFLImpl('0006') === 'src/a.py,app/[slug] | tags=x', `got: ${getFLImpl('0006')}`)
  await check('FL7 a list left open before a column-0 key does not swallow it (old string reading, note kept)',
    getFLImpl('0007') === "<string '['>" && getFLKey('0007', 'note') === 'kept', `got: ${getFLImpl('0007')} / note=${getFLKey('0007', 'note')}`)
  await check('FL8 a comment-only value is null, never the comment text (implements_in and a scalar key)',
    getFLImpl('0008') === '<null>' && getFLKey('0008', 'superseded_by') === '<null>', `got: ${getFLImpl('0008')} / superseded_by=${getFLKey('0008', 'superseded_by')}`)
  await check('FL9 a [-led title that is not a list keeps the keys after it',
    getFLKey('0009', 'title') === '[WIP] gate layer' && getFLKey('0009', 'status') === 'draft' && getFLImpl('0009') === 'src/w.py | tags=x',
    `got: title=${getFLKey('0009', 'title')} status=${getFLKey('0009', 'status')} impl=${getFLImpl('0009')}`)
  const e10 = flEntry('0010')[0] ?? {}
  await check('FL11 a double-quoted title keeps \\" and \\\\ unescaped (was cut at the first \\")', e10.title === 'say "hi" \\ done', `got: ${e10.title}`)
  await check('FL12 an inline list item carrying \\" is one item, unescaped', arr(e10.flow).join('|') === 'a "b"|c', `got: ${arr(e10.flow).join('|')}`)
  await check('FL13 a block list item carrying \\" is one item (the trailing comment is cut after the closing quote)', arr(e10.blk).join('|') === 'x "y" z|w', `got: ${arr(e10.blk).join('|')}`)
  await check('FL14 other backslash text is unchanged: \\n stays two characters, an unterminated "C:\\dir\\" keeps its reading',
    e10.raw === 'a\\nb' && e10.tail === 'C:\\dir\\', `raw=${e10.raw} tail=${e10.tail}`)
  const flHtml = rd(j(docsFL, 'docs.html'))
  await check('FL15 no javascript:, vbscript: or data: scheme survives as a link target, tab-split and control-led forms included',
    !/href="[^"]*(javascript|vbscript|data):/i.test(flHtml) && !flHtml.includes(`java${flTab}script`) && !flHtml.includes(`${flCtl}javascript`),
    'a blocked scheme reached docs.html')
  await check('FL16 an ordinary https link is still a link (the filter blocks schemes, not links)',
    flHtml.includes('<a href="https://example.com/p#q">ok</a>'), 'the https link is gone')
  const flIdxMd = rd(j(docsFL, 'INDEX.md'))
  await check('FL17 a bare integer in related_spec builds and lists as text in INDEX.md (was a TypeError)',
    flCode === 0 && /0001-r\.md\)[^\n]*\| 10 \|/i.test(flIdxMd), `exit=${flCode}: ${rFL.Out}`)
  // FL5: the consumer that a null would crash. verify_map over the index that this builder wrote
  // maps the changed file to every spec that lists it, whatever list shape the spec used.
  const rFL5 = nodeRun([verifyMap, '--repo', repoFL, 'src/b.py'])
  await check('FL5 verify_map maps src/b.py to the block, flow and compact specs (exit 0, no traceback)',
    rFL5.Code === 0 && !/Traceback/i.test(rFL5.Out) && /spec 0001 /i.test(rFL5.Out) && /spec 0002 /i.test(rFL5.Out)
    && /spec 0004 /i.test(rFL5.Out) && !/spec 0003 /i.test(rFL5.Out), `exit=${rFL5.Code}: ${rFL5.Out}`)
  // FL10: the comment-only spec reaches verify_map as null. Its warning must name a remedy that
  // clears it (`[]`), because a rebuild reproduces the null. The comment text never reaches it.
  await check('FL10 verify_map warns the comment-only spec as null and names the [] remedy',
    /spec 0008: implements_in in the index is null/i.test(rFL5.Out) && /or \[\] for a spec that owns nothing yet/i.test(rFL5.Out) && !/# TBD/i.test(rFL5.Out), rFL5.Out)

  // --- NR: the `narrows` relation (ywr-harness ADR 0196). An ADR names the ADRs it narrows, and the
  // builder derives the reverse line. NR1, NR2 and NR3 read one corpus from one build, because every
  // builder run is a process start. The corpus:
  //   0001 accepted   the target of 0002 (in force), 0003 (superseded), 0007 (rejected) and 0008 (deprecated)
  //   0002 accepted   narrows [1] as an int
  //   0003 superseded narrows ["0004", 1]: digit string and int, both out of every reverse list
  //   0004 accepted   named only by the superseded 0003, so it stays plain
  //   0005 accepted   a hand-written narrowed_by, which the builder ignores
  //   0006 accepted   narrows: [] (nothing)
  //   0007 rejected   narrows [1], a second status that leaves the reverse list
  //   0008 deprecated narrows [1, 1], a third status that leaves the reverse list
  //   spec 0001       narrows [1], ignored, because a spec has no accepted decision to narrow
  const repoNR = j(fx, 'repo-narrows')
  const docsNR = docsTree(repoNR)
  const writeNRDoc = (rel, body) => wr(j(docsNR, rel), body)
  const writeNRAdr = (num, status, extra) => writeNRDoc(`adr/${num}-x.md`, `---\nid: "${num}"\ntype: adr\ntitle: "adr ${num}"\nstatus: ${status}\n${extra}---\n# ${num}\nbody\n`)
  const buildNR = () => nodeRun([j(docsNR, 'build_docs.mjs')])
  writeNRAdr('0001', 'accepted', '')
  writeNRAdr('0002', 'accepted', 'narrows: [1]\n')
  writeNRAdr('0003', 'superseded', 'narrows: ["0004", 1]\n')
  writeNRAdr('0004', 'accepted', '')
  writeNRAdr('0005', 'accepted', 'narrowed_by: [1]\n')
  writeNRAdr('0006', 'accepted', 'narrows: []\n')
  writeNRAdr('0007', 'rejected', 'narrows: [1]\n')
  writeNRAdr('0008', 'deprecated', 'narrows: [1, 1]\n')
  writeNRDoc('spec/0001-s.md', '---\nid: "0001"\ntype: spec\ntitle: "s1"\nstatus: active\nnarrows: [1]\n---\n# spec 0001\n')
  const rNR = buildNR()
  const jsonNR = readJson(j(docsNR, 'index.json'))
  const indexNR = rd(j(docsNR, 'INDEX.md'))
  const htmlNR = rd(j(docsNR, 'docs.html'))
  const getNRKeys = (node) => Object.keys(jsonNR?.graph?.[node] ?? {}).join(',')
  const getNRRow = (num) => indexNR.split('\n').find((l) => new RegExp(`^\\| \\[${num}\\]`, 'i').test(l))
  const nr = (node, key) => arr(jsonNR?.graph?.[node]?.[key]).join(',')

  // NR1: the narrowing ADR carries `narrows`, the named ADR carries the derived `narrowed_by`, and
  // the INDEX.md status cell and the docs.html meta panel show both directions. Mutation anchor: a
  // builder that never derives the reverse relation, or never writes the graph keys, turns this red.
  await check('NR1 the corpus with narrows builds (exit 0)', rNR.Code === 0 && jsonNR, rNR.Out)
  await check('NR1 graph adr:0002 holds narrows [1], placed after superseded_by',
    getNRKeys('adr:0002') === 'related_adr,related_spec,superseded_by,narrows' && nr('adr:0002', 'narrows') === '1', `keys=${getNRKeys('adr:0002')}`)
  await check('NR1 graph adr:0001 holds narrowed_by [2] as ints, after superseded_by',
    getNRKeys('adr:0001') === 'related_adr,related_spec,superseded_by,narrowed_by' && nr('adr:0001', 'narrowed_by') === '2',
    `keys=${getNRKeys('adr:0001')} by=${nr('adr:0001', 'narrowed_by')}`)
  await check('NR1 the INDEX.md status cell of 0001 reads "Accepted · narrowed by #2"',
    /\| Accepted · narrowed by #2 \|/i.test(getNRRow('0001') ?? ''), `row=${getNRRow('0001')}`)
  await check('NR1 docs.html carries the narrows row (on 0002) and the reverse row (on 0001)',
    htmlNR.includes('<b>좁힘</b> <a href="#adr-0001">#1</a>') && htmlNR.includes('<b>좁혀짐</b> <a href="#adr-0002">#2</a>'), 'meta rows missing from docs.html')

  // NR2: a narrowing ADR that is superseded (0003), rejected (0007) or deprecated (0008) is left out
  // of the reverse list and of INDEX.md, while its own graph entry keeps `narrows`. 0004 is named only
  // by the superseded 0003, so it stays plain. The graph holds each number once, as an integer: the
  // digit string "0004" of 0003 and the repeated 1 of 0008 print as 4 and 1, and the meta panel links
  // them. Mutation anchor: dropping one status from the filter puts that ADR into 0001's list (and,
  // for superseded, a "narrowed by" cell on 0004); storing the list as written leaves "0004" and 1,1.
  await check('NR2 the superseded, the rejected and the deprecated narrowing ADR stay out of narrowed_by (0001 lists only #2)',
    nr('adr:0001', 'narrowed_by') === '2' && !/#3/i.test(getNRRow('0001') ?? '') && !/#7/i.test(getNRRow('0001') ?? '') && !/#8/i.test(getNRRow('0001') ?? ''), getNRRow('0001'))
  await check('NR2 0004 is named only by the superseded 0003: no narrowed_by key, no INDEX.md cell text',
    getNRKeys('adr:0004') === 'related_adr,related_spec,superseded_by' && !/narrowed by/i.test(getNRRow('0004') ?? ''), `keys=${getNRKeys('adr:0004')} row=${getNRRow('0004')}`)
  await check('NR2 0003, 0007 and 0008 keep their own narrows in the graph, each number once as an integer',
    nr('adr:0003', 'narrows') === '4,1' && typeof jsonNR?.graph?.['adr:0003']?.narrows?.[0] === 'number'
    && nr('adr:0007', 'narrows') === '1' && nr('adr:0008', 'narrows') === '1',
    `0003=${nr('adr:0003', 'narrows')} 0007=${nr('adr:0007', 'narrows')} 0008=${nr('adr:0008', 'narrows')}`)
  await check('NR2 the meta panel of 0003 links the digit-string item (#4 with its anchor)',
    htmlNR.includes('<b>좁힘</b> <a href="#adr-0004">#4</a>, <a href="#adr-0001">#1</a>'), 'the 0003 narrows row is not linked as #4, #1')

  // NR3: nothing appears without a non-empty narrows. 0005 (hand-written narrowed_by), 0006
  // (`narrows: []`) and the spec (narrows [1]) keep exactly the base keys. No row carries "narrowed
  // by" except 0001's, and docs.html holds four narrows rows (0002, 0003, 0007, 0008) and one
  // reverse row (0001). Mutation anchor: reading narrowed_by from the frontmatter, or reading
  // narrows on a spec, adds a key or a row here.
  await check('NR3 0005 (hand-written narrowed_by) and 0006 (narrows: []) hold exactly the legacy graph keys',
    getNRKeys('adr:0005') === 'related_adr,related_spec,superseded_by' && getNRKeys('adr:0006') === 'related_adr,related_spec,superseded_by',
    `0005=${getNRKeys('adr:0005')} 0006=${getNRKeys('adr:0006')}`)
  await check('NR3 the spec graph entry holds only based_on_adr (a spec narrows is ignored)', getNRKeys('spec:0001') === 'based_on_adr', `keys=${getNRKeys('spec:0001')}`)
  await check('NR3 only the row of 0001 carries "narrowed by"',
    indexNR.split('\n').filter((l) => /narrowed by/i.test(l)).length === 1 && !/narrowed by/i.test(getNRRow('0005') ?? ''), getNRRow('0005'))
  await check('NR3 docs.html holds four narrows rows and one reverse row, none for the spec or 0005',
    count(htmlNR, '<b>좁힘</b>') === 4 && count(htmlNR, '<b>좁혀짐</b>') === 1,
    `narrows=${count(htmlNR, '<b>좁힘</b>')} reverse=${count(htmlNR, '<b>좁혀짐</b>')}`)

  // NR4: a wrong `narrows` value is a refusal that names the file and the value. One fixture has one
  // file rewritten per run. The first kind runs as a normal build (non-zero exit), and the other
  // three run through --check (exit 2, the REFUSED line), so each kind costs one process start. The
  // message is Korean, so the build run matches the file name and the value only. The --check output
  // is ASCII (Korean as \uXXXX escapes), so those runs also match a word that only their kind's
  // message holds. That tells a non-number item from an unknown number. Mutation anchor: dropping
  // any of the four checks in resolve_narrows turns that kind's case red.
  const getNREscaped = (word) => [...word].map((c) => (c.charCodeAt(0) >= 128 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')
  const checkNR = () => nodeRun([j(docsNR, 'build_docs.mjs'), '--check'])
  writeNRAdr('0002', 'accepted', 'narrows: [99]\n')
  const rNR4a = buildNR()
  await check('NR4 an unknown ADR number fails the build and names the file and the value',
    rNR4a.Code !== 0 && /0002-x\.md/i.test(rNR4a.Out) && /99/i.test(rNR4a.Out) && !/Traceback/i.test(rNR4a.Out), rNR4a.Out)
  writeNRAdr('0002', 'accepted', 'narrows: [2]\n')
  const rNR4b = checkNR()
  await check('NR4 the ADR itself: --check exits 2 with REFUSED, naming the file',
    rNR4b.Code === 2 && /\[check\] REFUSED/i.test(rNR4b.Out) && /0002-x\.md/i.test(rNR4b.Out) && rNR4b.Out.includes(getNREscaped('자기 자신')), rNR4b.Out)
  writeNRAdr('0002', 'accepted', 'narrows: notalist\n')
  const rNR4c = checkNR()
  await check('NR4 a value that is not a list: --check exits 2 with REFUSED, naming the file and the value',
    rNR4c.Code === 2 && /\[check\] REFUSED/i.test(rNR4c.Out) && /0002-x\.md/i.test(rNR4c.Out) && /notalist/i.test(rNR4c.Out) && rNR4c.Out.includes(getNREscaped('리스트가')), rNR4c.Out)
  writeNRAdr('0002', 'accepted', 'narrows: [x7]\n')
  const rNR4d = checkNR()
  await check('NR4 an item that is not an ADR number: --check exits 2 with REFUSED, naming the file and the value',
    rNR4d.Code === 2 && /\[check\] REFUSED/i.test(rNR4d.Out) && /0002-x\.md/i.test(rNR4d.Out) && /x7/i.test(rNR4d.Out) && rNR4d.Out.includes(getNREscaped('번호가 아닙')), rNR4d.Out)

  // --- PY1: no shipped docs or scaffold script is Python (ywr-harness ADR 0223) -------------------------
  // No `.py` ships under templates/docs or templates/scripts/harness, where a member's repo would
  // run it (ADR 0223). The control file proves that the scan sees a `.py` where one is.
  const pyControlDir = j(fx, 'py-control')
  wr(j(pyControlDir, 'control.py'), 'print(1)\n')
  const pyScanDirs = [j(here, 'templates/docs'), j(here, 'templates/scripts/harness'), j(here, '../../scripts')]
  const listPy = (d) => {
    try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && /\.py$/i.test(e.name)).map((e) => j(d, e.name)) } catch { return [] }
  }
  const pyShipped = pyScanDirs.flatMap(listPy)
  const pyControlSeen = listPy(pyControlDir).length
  await check('PY1 no .py file ships under templates/docs, templates/scripts/harness or the plugin scripts (the scan sees the control file)',
    pyControlSeen === 1 && pyShipped.length === 0, `shipped python: ${pyShipped.join(', ')}`)

  // --- BW: the docs wrapper templates/docs/build.mjs (ADR 0220) ---------------------------------------
  // The wrapper runs the builder with this Node and hands the builder's exit code back unchanged. It
  // runs from a fixture docs tree like the builder above, as a node child with stdout and stderr read as UTF-8.
  const bwDocs = j(fx, 'bw', 'docs')
  mk(j(bwDocs, 'adr'), j(bwDocs, 'spec'))
  copyFileSync(j(here, 'templates/docs/build.mjs'), j(bwDocs, 'build.mjs'))
  copyFileSync(builderTemplate, j(bwDocs, 'build_docs.mjs'))
  wr(j(bwDocs, 'adr/0001-first.md'), '---\nid: "0001"\ntype: adr\ntitle: "first"\nstatus: accepted\n---\n# 0001\nbody\n')
  const wrapper = (over = {}) => nodeRun([j(bwDocs, 'build.mjs')], { env: envWith(over) })
  rm(j(bwDocs, 'index.json'))
  const rBW1 = wrapper()
  await check('BW1 a clean corpus builds through the wrapper: exit 0 and index.json exists',
    rBW1.Code === 0 && existsSync(j(bwDocs, 'index.json')), `exit=${rBW1.Code} out=${rBW1.Out}`)
  // A Python encoding variable in the environment does not reach a Node builder, so it must not
  // break the build. The wrapper sets no encoding pin.
  rm(j(bwDocs, 'index.json'))
  const rBW2 = wrapper({ PYTHONIOENCODING: 'cp1252', PYTHONUTF8: '0' })
  await check('BW2 an inherited cp1252 PYTHONIOENCODING does not break the build (the wrapper pins UTF-8)',
    rBW2.Code === 0 && existsSync(j(bwDocs, 'index.json')), `exit=${rBW2.Code} out=${rBW2.Out}`)
  // The builder's exit code is handed back unchanged. A duplicate id is a deterministic build failure
  // (ADR 0043), and a wrapper that turned it into 0 would remove the gate on the path a person runs.
  wr(j(bwDocs, 'adr/0002-rival.md'), '---\nid: "0001"\ntype: adr\ntitle: "rival"\nstatus: proposed\n---\n# 0001 again\n')
  const bwDirect = nodeRun([j(bwDocs, 'build_docs.mjs')])
  const rBW3 = wrapper()
  await check('BW3 the builder exit code passes through unchanged (a duplicate id is non-zero, equal to the direct run)',
    bwDirect.Code !== 0 && rBW3.Code === bwDirect.Code, `direct=${bwDirect.Code} wrapper=${rBW3.Code} out=${rBW3.Out}`)
  rm(j(bwDocs, 'adr/0002-rival.md'))
  // With no python on PATH the wrapper still builds, because the builder is Node. PATH is an empty
  // directory, and node starts by its full path.
  const bwEmpty = j(fx, 'bw-empty-path')
  mk(bwEmpty)
  rm(j(bwDocs, 'index.json'))
  const rBW4 = wrapper({ PATH: bwEmpty })
  await check('BW4 no python on PATH: the build still succeeds (exit 0, index.json exists)',
    rBW4.Code === 0 && existsSync(j(bwDocs, 'index.json')), `exit=${rBW4.Code} out=${rBW4.Out}`)
} finally {
  removeFixtureRoot(fx)
}
