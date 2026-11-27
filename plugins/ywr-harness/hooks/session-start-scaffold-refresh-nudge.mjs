// SessionStart, registered without a matcher: the drift condition is the filter, and a start after
// `compact` re-injects a fact that summaries lose. Scaffold-refresh nudge, suggest-only
// (ywr-harness ADR 0033). It also carries the slice rules (ywr-harness ADR 0183) and the slice-note
// rule (ywr-harness ADR 0172).
//
// Toolchain propagation is pull-based (ywr-harness ADR 0014): a plugin improvement reaches a
// scaffolded repo only on the next /ywr-harness:harness-init run. This hook byte-compares the
// installed plugin's templates against the repo's placements and speaks when a re-run would change
// something. A version stamp would nag on hook-only releases and stay silent on hand-edits.
//
// The placement map (TOOLCHAIN / GUARDED / GUARD_MARKER) is imported from
// skills/harness-init/placement.mjs at each firing and never duplicated: the hook, init.mjs and
// placement.mjs ship in one plugin version, and two copies of a rule drift apart. An import that
// fails, or a table that is no non-empty list of [source, destination] string pairs, gives an
// EXTRACTION-DRIFT banner, never silence. The banner is bounded to plausible-scaffold repos (a
// `scripts/harness/` directory), so a broken plugin does not banner every unrelated session.
//
// Comparison contract (ywr-harness ADR 0033):
//   - TOOLCHAIN placements: byte identity after dropping 0x0D. The seed .gitattributes pins
//     `* eol=lf` and `*.ps1 eol=crlf`, so one file differs in raw bytes between the repo checkout
//     and the installed copy. Content, encoding, BOM and letter case stay exact, and the comparison
//     is ordinal.
//   - A missing TOOLCHAIN placement is drift, named `(missing)`.
//   - GUARDED (post-commit) is compared only when it carries the marker. A marker-less file is
//     foreign, init.mjs refuses to touch it, and a re-run would change nothing, so the hook stays
//     silent (ywr-harness ADR 0029).
//   - SEED files are never compared, because their content is the consuming repo's decisions. The
//     one read of a seed is the retired-text scan below (ywr-harness ADR 0207), a fixed phrase list.
//
// Byte difference cannot tell "repo behind plugin" from "repo ahead of the installed plugin". The
// systemMessage says *differ*, never *outdated*, and additionalContext warns the model that a
// re-run would REVERT deliberately newer copies.
//
// Stale-basis probe (ywr-harness ADR 0039): a running session keeps the plugin version it loaded.
// Its hooks resolve to the OLD cache directory until /reload-plugins or a restart, and that
// directory outlives an update by about two weeks. In that window the verdict basis is stale and
// the advice inverts: the repo may match the NEWER registered install, and the harness-init that
// this session would run is the old skill. So, only after drift is found, the hook checks whether
// its own copy is still the registered install. It locates itself from its own path
// (<plugins>/cache/<marketplace>/<name>/<version>) and reads the registry beside it at
// <plugins>/installed_plugins.json, an undocumented file read best-effort (ywr-harness ADR 0027).
// Stale gives the same file list with the advice "reload, re-check, do NOT run harness-init from
// this session". A registered version equal to the running one gives the normal nudge, because the
// templates are the same. Any probe failure gives the normal nudge: the probe improves the advice
// and never silences the hook.
//
// Direction probe (ywr-harness ADR 0042): after drift, the normal branch reads the repo's
// `.harness-version` stamp. init.mjs writes it on every successful run. It is generated, never a
// template and never in the placement map, so it never counts as drift itself.
//   stamp > running       repo AHEAD: "update the plugin, do NOT init"
//   stamp < running       refresh advice, direction stated
//   equal                 hand-edit or partial placement, ywr-harness ADR 0010's intended signal
//   missing or unparsable direction-blind caveat on both output surfaces
// The stale-basis banner takes precedence over all of this. Probe failures fall through.
//
// Upstream-ahead probe (ywr-harness ADR 0135): the direction probe reads this checkout's stamp.
// After a teammate scaffolded or refreshed the repo and pushed, that stamp is the old one and reads
// "genuinely behind", which sends the person into a run that collides with the pushed scaffold. So,
// only after drift, after the stale-basis branch and after the stamp probe, the hook asks the
// remote-tracking refs whether they carry a commit that this checkout lacks and that touches
// `.harness-version`. The stamp alone counts: init.mjs writes it on every run that changes the
// version and on a first run, a same-version re-run places byte-identical templates, and a hand
// edit is no scaffold run. The walk is patch-equivalence filtered, so a local rebase or amend of a
// stamp commit is no hit. Candidates in order: the current branch's upstream, then origin/HEAD
// (init.mjs's offline default-branch signal, ywr-harness ADR 0062). A hit replaces the behind,
// equal and direction-blind branches: do NOT run harness-init, pull first. The repo-AHEAD branch
// keeps precedence and skips the probe, because it already forbids init. No network: the refs are
// as of the last fetch, and both messages say so. Any git failure is no hit, never an error line.
// init.mjs runs the same detection as a refusal (--allow-upstream-ahead).
//
// Payload and output contract (hooks reference): cwd per firing. systemMessage and
// hookSpecificOutput.additionalContext are both consumed. Plain stdout on exit 0 becomes context, so
// every path with nothing to say prints NOTHING. SessionStart cannot block, so the hook exits 0
// always and fails open. It writes nothing.
//
// Slice-note rule (ywr-harness ADR 0172): when the repo root holds scripts/harness/slice_note.mjs
// as a file, the hook states the rule for writing a slice note, as English additionalContext. The
// hook has no matcher, so the rule rides every source, a compaction included. It is the one output
// that is no drift finding. With no drift it is the whole output (additionalContext only), so "no
// drift = silent" holds only for a repo without the vendored script. On a drift emit the rule is
// appended to the ctx after a blank line. The SCHEMA-DRIFT, EXTRACTION-DRIFT and not-scaffolded
// paths carry no rule, because the rule is a fact about a scaffold that the hook has verified. The
// host caps each hook string at 10,000 characters. The longest drift ctx is about 1,200 characters
// and the rule about 600.
//
// Retired seed text (ywr-harness ADR 0207, narrows ywr-harness ADR 0033 and ywr-harness ADR 0183): after the
// scaffold gate, the hook reads CLAUDE.md, .claude/CLAUDE.md, REVIEW.md and the
// docs/prompts/ready-report.md seed, and looks for the phrases of RETIRED_SEED. A hit gives a Korean
// systemMessage that names each file and phrase, and an English part at the end of the rule text.
// It rides every source and every branch that carries the rule text, a no-drift start included,
// until a member edits the file. It costs up to three small file reads and no process.
//
// Review canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): where `.harness.json` is a file and the
// review canon it names exists, the hook checks the canon. A canon in CLAUDE.md, .claude/CLAUDE.md
// or CLAUDE.local.md loads at session start and passes. For a canon in any other file, one of those
// files must import it with an `@<path>` line. A missing import gives a Korean systemMessage line
// that names the canon and the two remedies, and an English part after the retired-text part. It
// rides the same sources and branches as the retired-text line.
//
// The two JSON files it reads (the plugin manifest, the installed-plugins registry) go through
// hook-lib's parseJsonLoose, which accepts comments and trailing commas. The stdin payload is
// strict JSON and keeps parseJson.
//
// Event-name comparison, key lookup and string conversion go through hook-lib with PowerShell
// semantics (case-insensitive lookup and compare, psString, .NET Trim; ywr-harness ADR 0116). Without
// git the verdict still runs: hook-lib's gitRun reports no git on PATH or ENOENT, and the verdict
// uses cwd as the root. The git call follows ywr-harness's git subprocess boundary (ywr-harness ADR 0077):
// `-c core.quotepath=false`, a bytes pipe, one UTF-8 decode, no shell. The hook never exits the
// process. It returns, so stdout drains and the exit code stays 0.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readStdin, parseJson, parseJsonLoose, isObject, getProp, psString, ieq, netTrim, inline, emit, gitRun, driftKeys, collator, markerAbove } from './hook-lib.mjs'

// Every failure (a root that does not exist on this platform, an illegal path) reads as "not there".
// A file is a regular file: the stamp read below must never open a device or FIFO on the
// SessionStart hot path.
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// git calls go through hook-lib's gitRun (PATH-resolved, absolute spawn, bytes decoded once).
const git = gitRun

// The slice-note rule (ywr-harness ADR 0172). ASCII only, one paragraph. It names the vendored path,
// because a session cannot expand ${CLAUDE_PLUGIN_ROOT}.
const SLICE_NOTE_RULE = 'Slice notes (ywr-harness ADR 0172): record each decision of this slice when you make it, with its reason: `node scripts/harness/slice_note.mjs add <kind> "<what and why>"`. Kinds: decision (an option chosen), rejected (an option dropped), owner (the owner\'s answer), fact (a figure established at cost), risk (a known limit or an unverified point). A compaction re-injects the notes, and /ywr-harness:slice-close reads them into the close as input, never proof.'

// The slice rules (ywr-harness ADR 0183). ASCII only. Each rule carries its own copy markers:
// phrases that only an old CLAUDE.md seed bullet of that rule held. A repo CLAUDE.md that holds any
// marker of a rule already loads that rule, so the hook leaves out that rule alone. A mention of the
// review workflow, a command or an ADR citation is no marker, because a repo can name those for its
// own reasons.
const SLICE_RULES_HEAD = 'ywr-harness slice rules for this repo (ywr-harness ADR 0183). The org guide states the general rules; this repo\'s CLAUDE.md states its own facts.'
const SLICE_RULES = [
  {
    id: 'review',
    copy: ['args.lensExtra'],
    text: '- Review: before a slice closes, run `/code-review` through the Skill tool: `medium` for a small tier and for a full tier (ywr-harness ADR 0215, ywr-harness ADR 0218). `/ywr-harness:slice-close` makes the call. Every finding gets a bucket: fixed, valid with no action, or false on reading. The review invariants are in the file that `.harness.json` `review.canon` names: the `## Review canon` section of `CLAUDE.md` in a new scaffold, where this repo\'s own invariants replace the harness-init starters (ywr-harness ADR 0217).',
  },
  {
    id: 'once',
    copy: ['review basis:', 'bounded re-review'],
    text: '- The review runs once per slice. Every finding gets one of three buckets. The severity limits the bucket: an `important`, `pre_existing` or ungraded finding ends fixed or false on reading, only a `nit` whose fix would change a design or a coverage ends valid with no action with an open item, and a fix that rests on an untested host behaviour gets a probe first; when the owner defers that probe, the finding ends valid with no action as an owner decision, with an open item (ywr-harness ADR 0216). A fix closes with re-run gates over its own files, and every fixed finding except a `nit` gets one fix check (ywr-harness ADR 0215). No fix gets a re-review. When a fix needs more review, record an open item: `node scripts/harness/slice_note.mjs add risk \"open item: review <files and lines> of the <file:line> fix; <why>\"`. A separate rule: a rebase or merge after the review re-arms it only over the overlap: reviewed files that the incoming commits touched, plus each hand-resolved conflict. An empty overlap keeps the review, recorded in the close as `review basis:` (ywr-harness ADR 0028, ywr-harness ADR 0072, ywr-harness ADR 0200).',
  },
  {
    id: 'close',
    copy: ['owner-typed', 'main session calls it'],
    text: '- The close: `/ywr-harness:slice-close` writes the handoff and the one commit. The person types it, or the main session calls it; a subagent never calls it (ywr-harness ADR 0201). The session prepares the close: it runs every command that `node scripts/harness/harness_gates.mjs` printed, the review with its fix checks, and verify. It writes no handoff and makes no commit itself. Its ready report ends with the line that `node scripts/harness/harness_gates.mjs --tree` printed after the final edit. After the report the session asks each open owner question with AskUserQuestion, then calls the skill. The close reuses the report only while it is verbatim in the same session and that line is unchanged; a new session or a compaction summary runs the full close (ywr-harness ADR 0105).',
  },
  {
    id: 'handoff',
    copy: ['handoff-archive'],
    text: '- Handoff: the `handoff` key in `.harness.json` names the resume file. A value that ends in `/` names a directory with one resume file per work line, named after the work line, never after a person. The close that supersedes a `## Current state` section moves it to `docs/handoff-archive/<same filename>`, newest first (ywr-harness ADR 0040).',
  },
  {
    id: 'artifacts',
    copy: ['<repo-name> '],
    text: '- Artifacts: a claude.ai Artifact that this repo publishes has the title `<repo-name> · <purpose>` and is declared under `artifacts` in `.harness.json`; CI then fails when the README lacks its link. A generated Artifact also declares its committed `source` file and a `check` drift gate, and `/ywr-harness:artifact-publish` republishes it with one confirmation, never headless (ywr-harness ADR 0032, ywr-harness ADR 0068).',
  },
]

// The slice-note rule's copy marker: the kinds list of the old CLAUDE.md seed bullet.
const SLICE_NOTE_COPY = ['decision|rejected|owner|fact|risk']
const COPY_NOTE = 'This repo\'s CLAUDE.md or .claude/CLAUDE.md holds its own copy of part of the ywr-harness slice rules, so the plugin does not repeat that part here. After that copy is deleted, the plugin states the current rules at each session start (ywr-harness ADR 0183).'

// Retired seed text (ywr-harness ADR 0207). harness-init never overwrites a seed file, so a
// scaffolded repo keeps a rule that a later release changed until a member edits the file. Each row
// names one phrase that only an old seed held, the repo files whose seed held it, the release whose
// seed dropped it and the ADR that changed the rule. A phrase never appears in the current seed or
// in the slice rules above, so a member's copy of the current rule never matches. The selftest pins
// both, and where the release tags are present it pins the version: the seed of that release lacks
// the phrase and the seed of the release before it holds it. `rule` names the slice rule that the
// phrase belongs to: a CLAUDE.md copy that holds the phrase is no copy of the current rule, so the
// hook states that rule (ywr-harness ADR 0183 decision 9). Matching is case-sensitive on text whose
// whitespace runs are collapsed to one space, so a wrapped line still matches. A new retirement adds
// rows here.
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md']
const READY = 'docs/prompts/ready-report.md'
// The CLAUDE.md seed dropped its slice-rule bullets in 0.72.0 (ywr-harness ADR 0183), before the
// rule itself changed, so its rows carry 0.72.0 and the ADR that later changed the rule.
// A row names a file that the real init.mjs places. The scaffold places no REVIEW.md
// (ywr-harness ADR 0217), but a repo whose review.canon names it still imports it into every review,
// so its rows stay. Its current text is the `## Review canon` section of the CLAUDE.md seed.
const RETIRED_SEED = [
  { phrase: 'bounded re-review', files: CLAUDE_FILES, rule: 'once', version: '0.72.0', adr: '0200' },
  { phrase: 'The close is owner-typed', files: CLAUDE_FILES, rule: 'close', version: '0.72.0', adr: '0201' },
  { phrase: 'bounded re-review', files: [READY], version: '0.77.0', adr: '0200' },
  { phrase: 'The owner types `/ywr-harness:slice-close`', files: [READY], version: '0.78.0', adr: '0201' },
  { phrase: 'A deny or a host refusal is final', files: [READY], version: '0.78.0', adr: '0201' },
  { phrase: 'asked again at the close', files: [READY], version: '0.78.0', adr: '0201' },
  { phrase: 'every confirmed finding has a disposition', files: [READY], version: '0.79.0', adr: '0206' },
  { phrase: 'For every confirmed finding, judge', files: ['REVIEW.md'], version: '0.79.0', adr: '0206' },
  { phrase: 'fix_proof.py check', files: [READY], version: '0.82.0', adr: '0215' },
  { phrase: 'one `class:` line per finding', files: ['REVIEW.md'], version: '0.82.0', adr: '0215' },
  { phrase: 'pwsh docs/build.ps1', files: CLAUDE_FILES, version: '0.84.0', adr: '0220' },
  { phrase: 'python scripts/harness/slice_note.py', files: [READY, 'docs/prompts/review-start.md'], version: '0.85.0', adr: '0223' },
]

// Whitespace runs to one space: the form both a phrase and a file text are compared in.
const squash = s => s.replace(/\s+/g, ' ')

// The retired rows found in the repo: [{ file, rows }] in table file order, one entry per file that holds a row.
// `texts` maps a repo-relative path to its squashed text, '' for an absent or unreadable file.
function findRetired(texts) {
  const order = []
  for (const r of RETIRED_SEED) for (const f of r.files) if (!order.includes(f)) order.push(f)
  const hits = []
  for (const file of order) {
    const rows = RETIRED_SEED.filter(r => r.files.includes(file) && texts.get(file).includes(r.phrase))
    if (rows.length) hits.push({ file, rows })
  }
  return hits
}

// The two surfaces of a retired-text finding: a Korean line for the person, an English part for the model.
function retiredText(hits, rootShow, templatesShow) {
  if (!hits.length) return { sys: '', ctx: '' }
  // The list is whole: the table names four files, so no cap applies.
  const list = hits.map(h => `${h.file} (${h.rows.map(r => `\`${r.phrase}\`: v${r.version}, ywr-harness ADR ${r.adr}`).join('; ')})`).join(', ')
  // The scaffold places no REVIEW.md, so its current text is in the CLAUDE.md seed (ywr-harness ADR 0217).
  const review = hits.some(h => h.file === 'REVIEW.md')
  const reviewSys = review ? ' REVIEW.md의 현재 문구는 seed 템플릿 CLAUDE.md의 `## Review canon` 섹션에 있습니다 (ywr-harness ADR 0217).' : ''
  const reviewCtx = review ? ' The scaffold places no REVIEW.md any more: its current text is the `## Review canon` section of the CLAUDE.md seed (ywr-harness ADR 0217).' : ''
  const sys = `[hook:scaffold-refresh-nudge] ${rootShow}: seed 파일 ${hits.length}개에 이후 릴리스가 바꾼 ywr-harness 규칙 문구가 남아 있습니다 — ${list}. /ywr-harness:harness-init은 seed 파일을 덮어쓰지 않으므로 직접 고쳐야 합니다. 현재 문구는 설치된 플러그인의 같은 이름 seed 템플릿에 있습니다: ${templatesShow}.${reviewSys} 고칠 때까지 세션을 시작할 때마다 알립니다 (ywr-harness ADR 0207). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
  const ctx = `Retired seed text (ywr-harness ADR 0207): these repo files still hold the text of a ywr-harness rule that a later release changed: ${list}. The version is the release whose seed dropped the text, and the ADR states the current rule. /ywr-harness:harness-init never overwrites a seed file. Where such a file disagrees with the current rule, follow the current rule: the slice rules of this context where they state it, else the ADR. The current seed text is in the installed plugin at ${templatesShow}.${reviewCtx} Do not edit these files unasked; the person decides the wording.`
  return { sys, ctx }
}

// The review canon import (ywr-harness ADR 0215, ywr-harness ADR 0217). `/code-review` reads CLAUDE.md and never a separate
// canon file, so a canon outside the memory files reaches the slice review only through an `@<path>` import, and
// harness-init never adds one to an existing CLAUDE.md.
// The rule is the emitter's (harness_gates.mjs canon_importer); keep the two in step. Claude Code reads an import
// anywhere in the text but skips code spans and fenced code blocks, so the check drops both first. A token then
// counts when it starts a line or follows whitespace. A relative token resolves against the folder of the file that
// holds it.
// An undeclared canon is CLAUDE.md. A root REVIEW.md, the file that older scaffolds seeded, takes its place, so that the
// hook asks for its import instead of passing while no review reads it (ywr-harness ADR 0217). The emitter's
// harness_config.load has the same default.
const CANON_DEFAULT = 'CLAUDE.md'
const CANON_LEGACY = 'REVIEW.md'
// The files whose imports the session loads from the repo root. CLAUDE.local.md is read for the import only, never for
// the copy markers or the retired-text scan. An ancestor CLAUDE.md above the repo root is not read.
const IMPORT_FILES = [...CLAUDE_FILES, 'CLAUDE.local.md']
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INDENTED = /^(?: {4}|\t)/
const CLOSER = /^(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/
const SETEXT = /^=+[ \t]*$/
const SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g
const IMPORT = /(?:^|(?<=\s))@((?:\\ |\S)+)/g
// The emitter's safe_path rejects these and falls back to the default; the hook does the same.
const CANON_UNSAFE = /[;&|`$<>\n\r"']|\.\./

// The canon path that `.harness.json` declares, '' when the hook does not check. A value that is no string is not
// checked: the emitter turns it into text, and the hook would name a different file.
function declaredCanon(text, root) {
  let cfg
  try { cfg = parseJsonLoose(text) } catch { return '' }
  if (!isObject(cfg)) return ''
  const rev = getProp(cfg, 'review')
  const v = isObject(rev) ? getProp(rev, 'canon') : undefined
  const fallback = isFile(path.join(root, CANON_LEGACY)) ? CANON_LEGACY : CANON_DEFAULT
  if (!v) return fallback
  if (typeof v !== 'string') return ''
  const canon = v.replace(/\\/g, '/').trim()
  return canon && !CANON_UNSAFE.test(canon) ? canon : fallback
}

// The text of a memory file with its code removed, as Claude Code reads it for imports. A probe on host 2.1.331
// (ywr-harness fact 250) loaded no import from a fenced code block, an indented code block or a code span. A fence closes
// only on its own character, at least as long, with nothing after it. An indented line is code after a blank line. It
// is code too after a column-0 closing fence, ATX heading, thematic break or setext underline, because each of them ends
// the paragraph before it (ywr-harness fact 256). The same block indented by one to three spaces can sit inside a list
// item, where the next indented line is item text. The reader tracks no list, so it leaves the state alone after an
// indented block. A list item's indented paragraph after a blank line reads as code here, which errs toward a missing
// import. A code span can cross a line break, so spans are removed per paragraph.
function importText(text) {
  const kept = []
  let fence = ''
  let blank = true
  let indented = false
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = FENCE.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
        fence = ''
        if (line[0] === '`' || line[0] === '~') { blank = true; indented = false }
      }
      kept.push('')
      continue
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = m[1]; kept.push(''); continue }
    if (!line.trim()) { blank = true; kept.push(''); continue }
    if (INDENTED.test(line) && (blank || indented)) { indented = true; kept.push(''); continue }
    blank = CLOSER.test(line) || (SETEXT.test(line) && !blank && !indented)
    indented = false
    kept.push(line)
  }
  return kept.join('\n').split(/\n[ \t]*\n/).map(p => p.replace(SPAN, ' ')).join('\n\n')
}

// The real path of the longest existing prefix plus the rest as written. It expands an 8.3 short name and a link,
// so an absolute token spelled through either still names the file that the session loads.
function realTarget(p) {
  const full = path.resolve(p)
  let cur = full
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return full
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

// Windows paths ignore case, and the probe loaded `@C4.MD` for c4.md there.
const normTarget = p => (process.platform === 'win32' ? realTarget(p).toLowerCase() : realTarget(p))

// The first of IMPORT_FILES whose text imports `canon`, or ''. A token counts when it starts a line or follows
// whitespace, after importText removed the code. A backslash-escaped space belongs to the token. A relative token
// resolves against the folder of the file that holds it, `~/` against the home folder, and an absolute token stands
// as written. The rule is the emitter's (harness_gates.mjs canon_importer); keep the two in step.
function canonImporter(root, texts, canon) {
  const want = normTarget(path.resolve(root, canon))
  for (const rel of IMPORT_FILES) {
    const folder = path.join(root, path.posix.dirname(rel))
    for (const m of importText(texts.get(rel) || '').matchAll(IMPORT)) {
      let tok = m[1].replace(/\\ /g, ' ')
      if (tok === '~' || tok.startsWith('~/')) tok = path.join(os.homedir(), tok.slice(1))
      if (normTarget(path.resolve(folder, tok)) === want) return rel
    }
  }
  return ''
}

// True when `canon` is one of IMPORT_FILES, a memory file the session loads at its start, so it needs no import
// (ywr-harness ADR 0217). The rule is the emitter's (harness_gates.mjs memory_canon); keep the two in step.
function memoryCanon(root, canon) {
  const want = normTarget(path.resolve(root, canon))
  return IMPORT_FILES.some(rel => normTarget(path.resolve(root, rel)) === want)
}

// The two surfaces of a missing import: a Korean line for the person, an English part for the model. The import
// line escapes each space with a backslash, the form Claude Code reads as one path.
function canonText(canon, rootShow) {
  const c = inline(canon, 200)
  const line = `@${c.replace(/ /g, '\\ ')}`
  const sys = `[hook:scaffold-refresh-nudge] ${rootShow}: CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md 어디에도 review canon \`${c}\`의 \`@\` import가 없습니다. slice-close 리뷰인 /code-review는 CLAUDE.md만 읽으므로, 이대로면 이 저장소의 리뷰 불변식 없이 리뷰합니다. 권장: \`${c}\`의 내용을 CLAUDE.md의 \`## Review canon\` 섹션으로 옮기고, .harness.json의 review.canon을 \`CLAUDE.md\`로 바꾼 뒤 \`${c}\`를 지우세요 (ywr-harness ADR 0217). 또는 CLAUDE.md에 \`${line}\` 줄을 추가하세요. /ywr-harness:harness-init은 기존 파일을 덮어쓰지 않습니다. 고칠 때까지 세션을 시작할 때마다 알립니다 (ywr-harness ADR 0215). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
  const ctx = `Review canon import (ywr-harness ADR 0215, ywr-harness ADR 0217): neither CLAUDE.md, .claude/CLAUDE.md nor CLAUDE.local.md imports the review canon \`${c}\` that .harness.json names. /code-review, the slice-close review, reads CLAUDE.md and never a separate canon file, so a review in this repo runs without its invariants. The recommended fix moves the content of \`${c}\` into a \`## Review canon\` section of CLAUDE.md, sets review.canon in .harness.json to \`CLAUDE.md\` and deletes \`${c}\`. The smaller fix is one \`${line}\` line in CLAUDE.md. The session that prepares a slice close adds that line before it calls /code-review, by stage 2 of /ywr-harness:slice-close. Any other session does not edit CLAUDE.md or move the canon unasked; the person decides.`
  return { sys, ctx }
}

// The rule text from four facts about the repo. `restate` holds the ids of the slice rules whose CLAUDE.md copy
// holds retired text: such a copy does not count as a copy.
function ruleText({ harnessJson, sliceNote, claudeMd, restate = new Set(), retiredCtx = '' }) {
  const has = markers => markers.some(m => claudeMd.includes(m))
  const parts = []
  let copied = false
  if (harnessJson) {
    const left = SLICE_RULES.filter(r => restate.has(r.id) || !has(r.copy))
    if (left.length < SLICE_RULES.length) copied = true
    if (left.length) parts.push([SLICE_RULES_HEAD, ...left.map(r => r.text)].join('\n'))
  }
  if (sliceNote) {
    if (has(SLICE_NOTE_COPY)) copied = true
    else parts.push(SLICE_NOTE_RULE)
  }
  if (copied) parts.push(COPY_NOTE)
  if (retiredCtx) parts.push(retiredCtx)
  return parts.join('\n\n')
}

function firstLine(text) {
  const i = text.indexOf('\n')
  return netTrim(i < 0 ? text : text.slice(0, i))
}

// A file as UTF-8 text without a leading BOM.
function readText(p) {
  let s = fs.readFileSync(p, 'utf8')
  while (s.startsWith(String.fromCharCode(0xfeff))) s = s.slice(1)
  return s
}

// PowerShell truthiness of a parsed JSON value (ywr-harness ADR 0116).
function psTruthy(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? psTruthy(v[0]) : true
  return true
}

// A property of a registry entry: undefined for anything that is not a JSON object.
function prop(e, name) {
  return isObject(e) ? getProp(e, name) : undefined
}

// A version has at most four components, and each must fit Int32.
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

// Upstream-ahead detection (ywr-harness ADR 0135), the same definition as init.mjs's guard, no
// network. Candidate refs in order, deduped: the current branch's upstream (accepted only on exit 0
// with a refs/ name), then the remote default branch (origin/HEAD, ywr-harness ADR 0062).
// A hit is `git --literal-pathspecs log -1 --cherry-pick --right-only HEAD...<ref> -- .harness-version`
// with exit 0 and a non-empty line. The first hit wins. The stamp is the only path, and
// --cherry-pick drops a commit whose patch HEAD already carries (a local rebase or amend not yet
// force-pushed). Any git failure is no hit. Returns { ref, sha, date } or null. `ref` is the short
// name (refs/remotes/ stripped) and repo-authored text, so the caller echoes it through inline().
function findUpstreamScaffoldAhead(root) {
  const refs = []
  const up = git(['-C', root, 'rev-parse', '--symbolic-full-name', '@{upstream}'])
  if (up.status === 0 && firstLine(up.text).startsWith('refs/')) refs.push(firstLine(up.text))
  const oh = git(['-C', root, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (oh.status === 0 && firstLine(oh.text).startsWith('refs/') && !refs.includes(firstLine(oh.text))) refs.push(firstLine(oh.text))
  for (const ref of refs) {
    const r = git(['--literal-pathspecs', '-C', root, 'log', '-1', '--cherry-pick', '--right-only', '--format=%h%x09%cs', `HEAD...${ref}`, '--', '.harness-version'])
    if (r.status !== 0) continue
    const line = firstLine(r.text)
    if (!line) continue
    const [sha, date = ''] = line.split('\t')
    return { ref: ref.replace(/^refs\/remotes\//, ''), sha, date }
  }
  return null
}

function parent(p) {
  const d = path.dirname(p)
  return d === p ? '' : d
}

function drift(payload) {
  const keys = driftKeys(payload)
  emit({ systemMessage: `[hook:scaffold-refresh-nudge] SCHEMA DRIFT — SessionStart 페이로드에 'cwd' 필드가 없어, 이 저장소의 벤더링된 툴체인이 설치된 플러그인과 일치하는지 확인할 수 없습니다. 수신된 키: ${keys}. 페이로드 형식을 다시 확인하고 hooks/session-start-scaffold-refresh-nudge.mjs을 수정하세요 (ywr-harness ADR 0033).` })
}

// A placement table the hook can compare by: a non-empty list of [source, destination] pairs of
// non-empty strings, no source repeated (compared case-insensitively, as a case-insensitive file
// system reads two spellings of one file). Anything else fails extraction whole, because a fragment
// in the map is a wrong path compared quietly.
function validMap(m) {
  if (!Array.isArray(m) || m.length === 0) return false
  const seen = new Set()
  for (const e of m) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !e[0] || typeof e[1] !== 'string' || !e[1]) return false
    const k = e[0].toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
  }
  return true
}

async function main(payload) {
  const cwd = netTrim(psString(getProp(payload, 'cwd')))
  if (!cwd) return drift(payload)
  // No `scripts/harness/` from cwd upward: the plausible-scaffold gate below cannot pass, so the hook
  // starts no git.
  if (!markerAbove(cwd, 'scripts/harness')) return

  // Resolve the work tree root from cwd so a subdirectory session still finds the repo. Without git
  // the verdict still runs, because it reads the filesystem only. It uses cwd as the root, so a
  // subdirectory session stays silent in that case.
  let root
  const top = git(['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.absent) root = cwd
  else {
    root = firstLine(top.text)
    if (top.status !== 0 || !root) return
  }

  // Every path echoed into a banner goes through inline(): a directory name of a cloned repo is
  // attacker-authored text, and a model reads this output.
  const rootShow = inline(root, 300)

  // Plausible-scaffold gate: init.mjs places scripts/harness/ unconditionally, so a repo without it
  // was never scaffolded. It also bounds the extraction banner below to repos where a scaffold
  // plausibly exists.
  if (!isDir(path.join(root, 'scripts/harness'))) return

  // --- placement map, imported from placement.mjs, never copied (ywr-harness ADR 0033) ----------
  // process.argv[1] keeps the path as launched, while import.meta.url is realpath'd.
  const here = path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url))
  const pluginRoot = path.resolve(here, '..')
  const placementPath = path.join(pluginRoot, 'skills/harness-init/placement.mjs')
  const templatesDir = path.join(pluginRoot, 'skills/harness-init/templates')

  const extractionDrift = detail => emit({
    systemMessage: `[hook:scaffold-refresh-nudge] EXTRACTION DRIFT — ${detail} — 이 저장소(${rootShow})의 벤더링된 툴체인이 설치된 플러그인과 일치하는지는 UNKNOWN, 확인되지 않았습니다. 설치된 플러그인 자체의 파일이 일관되지 않습니다: ywr-harness를 업데이트하거나 재설치하고 이를 보고하세요 (ywr-harness ADR 0033).`,
  })

  let toolchain = null
  let guarded = null
  let marker = null
  if (isFile(placementPath)) {
    try {
      const mod = await import(pathToFileURL(placementPath).href)
      if (validMap(mod.TOOLCHAIN) && validMap(mod.GUARDED) && typeof mod.GUARD_MARKER === 'string' && mod.GUARD_MARKER) {
        toolchain = mod.TOOLCHAIN.map(e => [e[0], e[1]])
        guarded = mod.GUARDED.map(e => [e[0], e[1]])
        marker = mod.GUARD_MARKER
      }
    } catch { toolchain = guarded = marker = null }
  }
  if (!toolchain || !guarded || !marker) {
    return extractionDrift('설치된 플러그인의 skills/harness-init/placement.mjs에서 배치 맵을 읽을 수 없습니다 (TOOLCHAIN/GUARDED/GUARD_MARKER export)')
  }

  // File-level sentinel: the directory gate above is a plausibility bound, and ownership is decided
  // here. A repo with its own scripts/harness/ but none of the mapped vendored scripts was not
  // scaffolded by us, and counting everything "missing" there would be a false nudge. The `.py`
  // names that an older scaffold placed count too (ywr-harness ADR 0223), because a repo that has
  // not taken the Node scripts yet is the one this nudge exists for.
  const nodeSentinels = toolchain.map(e => e[1]).filter(v => /^scripts\/harness\/.+\.mjs$/i.test(v))
  const sentinels = [...nodeSentinels, ...nodeSentinels.map(v => v.replace(/\.mjs$/i, '.py'))]
  if (!nodeSentinels.length) {
    // The regex above assumes the map's contents, not only that it extracts. If the vendored
    // scripts ever move, an empty list would silently disable this hook on every repo.
    return extractionDrift('추출된 배치 맵에 scripts/harness/*.mjs 대상이 없어, 이 훅이 기준으로 삼는 ownership sentinel이 placement.mjs에서 이동했습니다')
  }
  if (!sentinels.some(s => isFile(path.join(root, s)))) return

  // The seed files the hook reads, as text; an absent or unreadable file is ''. The CLAUDE.md pair feeds the copy
  // markers (ywr-harness ADR 0183); every file feeds the retired-text scan (ywr-harness ADR 0207).
  const raw = new Map()
  for (const r of RETIRED_SEED) {
    for (const rel of r.files) {
      if (raw.has(rel)) continue
      let t = ''
      try { if (isFile(path.join(root, rel))) t = readText(path.join(root, rel)) } catch { t = '' }
      raw.set(rel, t)
    }
  }
  const hits = findRetired(new Map([...raw].map(([k, v]) => [k, squash(v)])))
  const retired = retiredText(hits, rootShow, inline(templatesDir, 300))
  const restate = new Set(hits.filter(h => CLAUDE_FILES.includes(h.file)).flatMap(h => h.rows.map(r => r.rule)).filter(Boolean))

  // The review canon import (ywr-harness ADR 0215): checked only where `.harness.json` is a file and the canon file
  // it names exists, because an import of a missing file reviews nothing either. The cost is up to two more small
  // file reads and two stats; no process, no git call.
  const harnessJson = isFile(path.join(root, '.harness.json'))
  let canonNote = { sys: '', ctx: '' }
  if (harnessJson) {
    let canon = ''
    try { canon = declaredCanon(readText(path.join(root, '.harness.json')), root) } catch { canon = '' }
    if (canon && isFile(path.resolve(root, canon)) && !memoryCanon(root, canon)) {
      const texts = new Map(raw)
      if (!texts.has('CLAUDE.local.md')) {
        let t = ''
        try { if (isFile(path.join(root, 'CLAUDE.local.md'))) t = readText(path.join(root, 'CLAUDE.local.md')) } catch { t = '' }
        texts.set('CLAUDE.local.md', t)
      }
      if (!canonImporter(root, texts, canon)) canonNote = canonText(canon, rootShow)
    }
  }
  // The person-facing lines and the model parts of the two seed findings, retired text first.
  const notes = {
    sys: [retired.sys, canonNote.sys].filter(Boolean).join('\n'),
    ctx: [retired.ctx, canonNote.ctx].filter(Boolean).join('\n\n'),
  }

  // The rule text (ywr-harness ADR 0183): the slice rules where `.harness.json` is a file, the slice-note rule (ywr-harness ADR 0172)
  // where the vendored script is a file. A part the repo's own CLAUDE.md already copies is left out, and the
  // copy note says so: a session never loads one rule twice. A copy that holds retired text is no copy, and the
  // retired-text part and the canon-import part come last (ywr-harness ADR 0207, ywr-harness ADR 0215). '' = no rule text.
  const rule = ruleText({
    harnessJson,
    sliceNote: isFile(path.join(root, 'scripts/harness/slice_note.mjs')),
    claudeMd: CLAUDE_FILES.map(rel => raw.get(rel)).join('\n'),
    restate,
    retiredCtx: notes.ctx,
  })
  // ctx plus the rule text, a blank line between; ctx alone when the rule text is empty.
  const withRule = ctx => (rule ? ctx + '\n\n' + rule : ctx)
  // A drift banner plus the seed-finding lines, a newline between (ywr-harness ADR 0207, ywr-harness ADR 0215).
  const withRetired = sys => (notes.sys ? sys + '\n' + notes.sys : sys)

  // EOL-insensitive comparable text. Latin1 maps bytes 1:1 to chars, so this is a byte comparison
  // modulo 0x0D, not a decode, and a real encoding or BOM change still differs.
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
      // A marker-less file is foreign, init.mjs refuses it, and a re-run changes nothing: silent.
      if (body.includes(marker) && body !== comparable(src)) drifted.push(rel)
    } catch { drifted.push(`${rel} (unreadable)`) }
  }

  if (!drifted.length) {
    // No drift: the rule is the whole output, with no systemMessage, because a person has nothing to
    // act on. A seed file with retired text or a missing canon import is the exception, because the
    // person must edit it (ywr-harness ADR 0207, ywr-harness ADR 0215).
    if (notes.sys) emit({ systemMessage: notes.sys, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rule } })
    else if (rule) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rule } })
    return
  }

  let ver = 'version unknown'
  try {
    const mf = parseJsonLoose(readText(path.join(pluginRoot, '.claude-plugin/plugin.json')))
    if (isObject(mf)) {
      const v = getProp(mf, 'version')
      if (psTruthy(v)) ver = `v${psString(v)}`
    }
  } catch { /* keep 'version unknown' */ }

  // The list is capped at five and the cap is stated, because a silent truncation reads as full coverage.
  const shown = drifted.slice(0, 5)
  let fileList = shown.join(', ')
  if (drifted.length > shown.length) fileList += `, +${drifted.length - shown.length} more`

  // --- stale-basis probe (ywr-harness ADR 0039), see the header ----------------------------------
  // Path equality is case-insensitive. On Linux a false match only degrades to the normal nudge,
  // which is the safe direction. Any failure is caught and yields null.
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
    // Only a versioned cache copy can be superseded. A --plugin-dir or repo-source copy has no
    // `cache` great-grandparent and stays on the ywr-harness ADR 0033 contract (direction-blind
    // caveat), the right reading for a deliberately loaded local copy.
    if (cacheDir && ieq(path.basename(cacheDir), 'cache')) {
      const pluginsDir = parent(cacheDir)
      const regPath = pluginsDir ? path.join(pluginsDir, 'installed_plugins.json') : ''
      if (regPath && isFile(regPath)) {
        const pluginName = path.basename(nameDir)
        const reg = parseJsonLoose(readText(regPath))
        // The name comes from the path, not plugin.json: the registry keys index by path, and the path
        // survives an unreadable manifest. The `@<marketplace>` half is not pinned, because an org may
        // register the marketplace under another name (ywr-harness ADR 0027).
        const plugins = isObject(reg) ? getProp(reg, 'plugins') : undefined
        const entries = []
        if (isObject(plugins)) {
          const prefix = (pluginName + '@').toUpperCase()
          for (const name of Object.keys(plugins)) {
            if (!name.toUpperCase().startsWith(prefix)) continue
            const v = plugins[name]
            if (Array.isArray(v)) entries.push(...v)
            else entries.push(v)                   // a null value is a null entry
          }
        }
        if (entries.length) {
          const current = entries.some(e => {
            const ip = fullPath(prop(e, 'installPath'))
            return ip && ieq(ip, rr)
          })
          if (!current) {
            // At least one entry and none is this copy: the session outlived an update or a scope
            // re-install. The registered version for the message follows the statusline's pick order
            // (ywr-harness spec 0010): user scope wins, then lastUpdated recency, never registry order.
            // A usable version is a scalar string with a digit. An array would space-join into a
            // malformed "1.0.0 2.0.0", and the registry's "unknown" sentinel fails the digit test.
            let best = null
            for (const e of entries) {
              const ev = prop(e, 'version')
              if (typeof ev !== 'string' || !/\d/.test(ev)) continue
              const eu = ieq(psString(prop(e, 'scope')), 'user')
              const bu = best !== null && ieq(psString(prop(best, 'scope')), 'user')
              if (best === null || (eu && !bu) || (eu === bu && collator.compare(psString(prop(e, 'lastUpdated')), psString(prop(best, 'lastUpdated'))) > 0)) best = e
            }
            staleActive = best ? 'v' + psString(prop(best, 'version')).replace(/^v/i, '') : 'version unknown'
            // The same version string as the running copy is not stale for advice: a same-version
            // re-registration (cross-marketplace key, cache re-seed) ships the same templates, so the
            // advice is not inverted, and "still runs $ver while the install is $ver" would
            // contradict itself. The comparison is case-insensitive. Two 'version unknown' values
            // fall back to the normal nudge too, because nothing is provable.
            if (ieq(staleActive, ver)) staleActive = null
          }
        }
      }
    }
  } catch { staleActive = null }

  if (staleActive) {
    const sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${drifted.length}개의 벤더링된 툴체인 파일이 이 세션의 ywr-harness (${ver}) 템플릿과 다릅니다 — ${fileList} — 하지만 비교 기준이 STALE합니다: 이 세션은 여전히 ${ver}를 실행 중이지만 이 머신에 등록된 설치는 ${staleActive}입니다. 판정이 뒤집혔을 수 있습니다 (저장소가 단순히 더 새로운 설치와 일치할 수 있습니다). /reload-plugins를 실행하거나 (또는 세션을 재시작) 다음 세션 시작 시 다시 확인하세요; 이 세션에서는 /ywr-harness:harness-init을 실행하지 마세요 — ${ver} 템플릿을 배치하게 됩니다 (ywr-harness ADR 0039). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    const ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}), but the verdict basis is STALE: this session's ywr-harness hooks and skills still run ${ver} while the machine's registered install is ${staleActive} — a running session keeps the plugin version it loaded until /reload-plugins or a restart. The drift verdict may therefore be inverted: the repo may already match the newer install's templates. Do NOT run or suggest /ywr-harness:harness-init from this session — the loaded skill would place the ${ver} templates and could REVERT correctly refreshed files (ywr-harness ADR 0039). The remedy is /reload-plugins or a session restart, after which the next session start re-checks against the updated plugin. This surface is suggest-only (ywr-harness ADR 0033).`
    emit({ systemMessage: withRetired(sys), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: withRule(ctx) } })
    return
  }

  const fileClause = `${drifted.length}개의 벤더링된 툴체인 파일이 설치된 ywr-harness (${ver}) 템플릿과 다릅니다 — ${fileList}`

  // --- direction probe (ywr-harness ADR 0042), normal branch only --------------------------------
  // The stale-basis banner above already forbids init and takes precedence. Here drift is real and
  // the session is current, but byte comparison cannot say which side is newer. Another writer that
  // refreshed this repo with a newer plugin is an ordinary state, not the edge that
  // ywr-harness ADR 0033 accepted. `.harness-version` orients the advice: repo-ahead says "update the plugin,
  // do NOT init", repo-behind states the direction, same-version names a hand-edit, and
  // unreadable or missing falls back to direction-blind with the caveat on both surfaces. Every
  // probe failure is caught, so stderr stays clean.
  let stampVer = null
  let stampDisp = ''
  try {
    const sp = path.join(root, '.harness-version')
    if (isFile(sp)) {
      // A bounded read: a whole-file read would take a stamp with no newline as one line, on the hot
      // path of every SessionStart. 64 bytes is generous for a version token, and anything longer is
      // a clean parse failure. The BOM is skipped and the first line is cut by hand.
      const buf = Buffer.alloc(64)
      const fd = fs.openSync(sp, 'r')
      let n
      try { n = fs.readSync(fd, buf, 0, 64, 0) } finally { fs.closeSync(fd) }
      const off = n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
      // ASCII decode: a byte above 0x7F becomes '?'
      let t = ''
      for (let i = off; i < n; i++) t += buf[i] > 0x7f ? '?' : String.fromCharCode(buf[i])
      const cut = t.search(/[\r\n]/)
      if (cut >= 0) t = t.slice(0, cut)
      t = netTrim(t).replace(/^v/i, '')
      if (/^\d+(\.\d+)+$/.test(t)) {
        // Normalize to four components before comparing, so '0.28' equals '0.28.0' and the direction
        // verdict holds. init.mjs's toVersionOrNull follows the same rule. More than four components
        // stay invalid. The display keeps the raw token.
        const sv = toVersion(t.split('.'))
        if (sv) { stampVer = sv; stampDisp = `v${t}` }
      }
    }
  } catch { stampVer = null; stampDisp = '' }
  let runVer = null
  const rm = /^v(\d+(\.\d+)+)$/.exec(ver)
  if (rm) runVer = toVersion(rm[1].split('.'))

  const both = stampVer && runVer
  const cmp = both ? cmpVersion(stampVer, runVer) : 0

  // --- upstream-ahead probe (ywr-harness ADR 0135), after the stale-basis branch and the stamp probe
  // Drift is real and the session is current, but the remedy may be a pull, not a re-run. A hit
  // replaces the behind, equal and direction-blind branches (ywr-harness ADR 0042): the local stamp
  // is the old one, and "genuinely behind" would send the person into a run that collides with the
  // pushed scaffold. Repo-AHEAD keeps precedence and skips the probe, because its advice already
  // forbids init. The probe runs only after drift, so the no-drift hot path starts no git. Any git
  // failure is no hit.
  const hit = both && cmp > 0 ? null : findUpstreamScaffoldAhead(root)
  if (hit) {
    const refShow = inline(hit.ref, 200)
    const shaShow = inline(hit.sha, 40)
    const dateShow = inline(hit.date, 40)
    const sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause} — 그리고 ${refShow}에 이 체크아웃에 없고 스캐폴드 스탬프(.harness-version)를 변경하는 커밋이 있습니다 (최신 ${shaShow}, ${dateShow}) — 다른 클론이 이 저장소를 스캐폴딩하거나 리프레시한 뒤 push한 것입니다. 지금 /ywr-harness:harness-init을 실행하지 마세요; 먼저 pull(${refShow}를 merge 또는 rebase)하세요. 다음 세션 시작 시 다시 확인합니다. ref는 마지막 fetch 시점 기준입니다 (ywr-harness ADR 0135). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    const ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}), but ${refShow} has commit(s) not in this checkout that change the scaffold stamp, .harness-version (newest ${shaShow}, ${dateShow}): another clone scaffolded or refreshed this repo and pushed (ywr-harness ADR 0135). The drift is therefore most likely this checkout lagging, not the repo lagging the plugin. Do NOT run or suggest /ywr-harness:harness-init from this session — it would place files that collide with the pushed scaffold at the next pull, or put older templates over a newer refresh. Offer pulling instead (merge or rebase ${refShow}); the next session start re-checks. The refs are remote-tracking refs as of the last fetch; no network was used. This surface is suggest-only (ywr-harness ADR 0033).`
    emit({ systemMessage: withRetired(sys), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: withRule(ctx) } })
    return
  }

  let sys
  let ctx
  if (both && cmp > 0) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause} — 그리고 이 저장소의 .harness-version 스탬프에 따르면 마지막으로 ywr-harness ${stampDisp} 로 스캐폴딩되었으며, 이는 이 세션의 ${ver} 보다 NEWER합니다. 저장소가 AHEAD 상태입니다: 이 세션에서 /ywr-harness:harness-init을 실행하지 마세요 — 더 오래된 ${ver} 템플릿을 배치하여 더 새로운 리프레시를 REVERT하게 됩니다 (ywr-harness ADR 0042). 해결 방법: /ywr-harness:update (또는 'claude plugin update')를 실행한 뒤 재시작하거나 /reload-plugins 후 다시 확인하세요. 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}), and its .harness-version stamp (${stampDisp}) is NEWER than this session's installed ywr-harness (${ver}) — another writer refreshed this repo with a newer plugin (ywr-harness ADR 0042). Do NOT run or suggest /ywr-harness:harness-init from this session: the loaded skill would place the ${ver} templates and REVERT the newer refresh. The remedy is updating the plugin (/ywr-harness:update or 'claude plugin update') and reloading or restarting; the next session start re-checks. This surface is suggest-only (ywr-harness ADR 0033).`
  } else if (both && cmp < 0) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause}. 이 저장소의 .harness-version 스탬프(${stampDisp})는 이 세션의 ${ver} 보다 OLDER합니다 — 리프레시 방향은 추측이 아니라 측정된 것입니다 (ywr-harness ADR 0042). 리프레시: 이 저장소에서 /ywr-harness:harness-init을 한 번 실행하고 커밋하세요 (여기서는 재실행이 안전합니다: 툴체인만 갱신되고, 시드는 보존되며, 아무것도 삭제되지 않습니다 — ywr-harness ADR 0010). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    ctx = `The repo at ${rootShow} carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates (${ver}), and the repo's .harness-version stamp (${stampDisp}) is OLDER than the installed plugin — the repo is genuinely behind (ywr-harness ADR 0042). A /ywr-harness:harness-init re-run refreshes the toolchain from the canon and never touches seeds or accumulated ADRs. Offer the re-run when the work touches gates, hooks, or CI; do not run it unasked — this surface is suggest-only (ywr-harness ADR 0033).`
  } else if (both) {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause} — 저장소의 .harness-version 스탬프가 이 세션의 ${ver} 와 EQUALS이므로, 이 차이는 버전 격차가 아니라 수동 편집(hand-edit) 또는 불완전한 배치입니다 (ywr-harness ADR 0042). /ywr-harness:harness-init을 재실행하면 수동 편집을 캐논 템플릿으로 REVERT하게 됩니다 — 이는 ywr-harness ADR 0010이 의도한 신호입니다 (하니스 결함은 캐논에서 고치며, 소비 저장소에서 패치하지 않습니다). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    ctx = `The repo at ${rootShow} shows scaffold-toolchain drift (${fileList}) at the SAME version as this session's installed plugin (stamp ${stampDisp} equals ${ver}): a hand-edit or partial placement, not staleness (ywr-harness ADR 0042). A harness-init re-run reverts hand-edits — the intended ywr-harness ADR 0010 signal, but confirm the edits are not deliberate local work in progress before suggesting it. This surface is suggest-only (ywr-harness ADR 0033).`
  } else {
    sys = `[hook:scaffold-refresh-nudge] ${rootShow}: ${fileClause}. CAVEAT — 이 비교는 direction-blind 상태입니다 (읽을 수 있는 .harness-version 스탬프 없음): 만약 다른 작성자가 이 머신보다 더 새로운 플러그인으로 이 저장소를 리프레시했다면, 여기서 /ywr-harness:harness-init을 재실행하면 그 리프레시를 REVERT하게 됩니다 (ywr-harness ADR 0042). 실행하기 전에 설치된 플러그인이 최신인지 확인하세요 (/ywr-harness:update); 그 외에는 재실행이 안전합니다 (툴체인 갱신, 시드 보존, 삭제 없음 — ywr-harness ADR 0010). 아무것도 변경되지 않았습니다; 이 훅은 제안만 합니다 (ywr-harness ADR 0033).`
    ctx = `The repo at ${rootShow} carries a ywr-harness scaffold whose placed toolchain differs from the installed plugin's templates (${ver}): ${fileList}. No readable .harness-version stamp, so the comparison is DIRECTION-BLIND: if this working tree deliberately carries NEWER copies than the installed plugin (the canon mid-slice, or a multi-writer repo refreshed by a newer plugin), a re-run would REVERT them to the older installed templates (ywr-harness ADR 0042). Offer the re-run when the work touches gates, hooks, or CI, after confirming the installed plugin is current; do not run it unasked — this surface is suggest-only (ywr-harness ADR 0033).`
  }
  emit({ systemMessage: withRetired(sys), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: withRule(ctx) } })
}

try {
  const payload = parseJson(readStdin())
  if (isObject(payload) && ieq(psString(getProp(payload, 'hook_event_name')), 'SessionStart')) await main(payload)
} catch { /* fail-open: a hook defect is never a blocked session */ }
