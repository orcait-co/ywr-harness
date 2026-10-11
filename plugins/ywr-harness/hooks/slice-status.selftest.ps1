# Self-test for slice-status.mjs, the observe-only slice status line (Claude Mods; ADR 0138), and for
# mods.mjs, the hooks-module entry. Since ADR 0140 the entry registers delegation-ledger.mjs alone: the
# module stays in the tree, unregistered, and this suite keeps its logic tested for a redesign.
# Usage: pwsh plugins/ywr-harness/hooks/slice-status.selftest.ps1
#
# CI has no claude CLI, so the module is driven here under plain node with a FAKE engine: a fake `on`
# captures the hooks, a fake `$` answers session.root, fs.exists and ui.status, and each `next` is a stub
# whose result the hook must hand back untouched. What this suite proves: every hook is pass-through
# (the result `next` resolved to is returned as is, the frozen event is never rewritten), the zone
# boundaries match the org guide's start rule, the `--tree` count starts, grows and resets as ADR 0138
# Decision 4 says, nothing shows outside a `.harness.json` root, a failing engine call never reaches the
# call, the line carries no command or path text, and the entry registers the ledger and not this
# module (the probe imports `mods.mjs` itself, so a missing or renamed module file fails this suite;
# the manifest gate checks only the entry path). What it cannot
# prove — the engine's event shapes, `isReadOnly` on a live shell call and how the line looks — is
# `claude plugin validate`'s and the live `--plugin-dir` probe's; `claude plugin test` stays a local habit.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core
Assert-NodeOrExit 'slice-status'
$mod = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'slice-status.mjs'))
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mods.mjs'))

$probe = @'
import { pathToFileURL } from 'node:url'
const M = await import(pathToFileURL(process.argv[2]).href)
const ENTRY = await import(pathToFileURL(process.argv[3]).href)
const results = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  results.push(g === w ? [name, 'OK'] : [name, 'FAIL got ' + g + ' want ' + w])
}
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }
const ROOT = 'C:/repo'

// `adopted`: the roots that hold `.harness.json` (a Set, changeable mid-test). `failExists` makes
// fs.exists throw that many times.
function engine({ root = ROOT, adopted = new Set([ROOT]), failRoot = 0, failStatus = 0, failExists = 0 } = {}) {
  const hooks = {}
  const on = (ev, a, b) => { hooks[ev] = b ?? a; return { catch() {} } }
  M.register(on, {})
  const lines = []
  const $ = {
    session: { root: async () => { if (failRoot > 0) { failRoot--; throw new Error('no root') } return root } },
    fs: { exists: async p => { if (failExists > 0) { failExists--; throw new Error('EIO') } return [...adopted].some(a => p === `${a}/.harness.json`) } },
    ui: { status: t => { if (failStatus > 0) { failStatus--; throw new Error('no surface') } lines.push(t) } },
  }
  const shown = () => lines[lines.length - 1]
  return { hooks, $, lines, shown, adopted, setRoot: r => { root = r } }
}
// One hook call through a stub `next`; answers what the hook returned and whether it is `next`'s result.
async function through(E, ev, e, result) {
  const frozen = deepFreeze(e)
  let seen = null
  const r = await E.hooks[ev](E.$, frozen, async x => { seen = x; return result })
  return { r, same: r === result, passed: seen === frozen }
}
const tool = (E, e, result) => through(E, 'tool.call', e, result)
// Every result carries the line a `--tree` run prints; only a call `isTreeRun` shapes as a run reads it.
const TREE_LINE = 'tree: ' + 'a'.repeat(40) + ' · HEAD ' + 'b'.repeat(40)
const FAILED_TREE = { isError: true, text: 'tree: FAILED — not a git work tree' }
const ok = (extra = {}) => ({ ref: 'x', result: {}, text: TREE_LINE, ...extra })
const measure = (E, context) => through(E, 'session.measure', { context, rateLimits: [], changed: ['context'] }, { changed: ['context'] })
const TREE = 'python scripts/harness/harness_gates.py --tree'

// --- pure half ---
{
  const z = (percent, tokens, window = 200000) => M.zoneOf({ percent, tokens, window })
  eq('zone boundaries (guide: <35 start, 35..60 scoped, >60 close, >=85 no plan)',
    [z(0), z(34), z(35), z(60), z(61), z(84), z(85), z(100)],
    ['start', 'start', 'scoped', 'scoped', 'close', 'close', 'noplan', 'noplan'])
  eq('a 1M window past 200k tokens is "fresh"; at 200k exactly it is not',
    [z(20, 200000, 1000000), z(21, 200001, 1000000), z(40, 400000, 1000000), z(70, 700000, 1000000), z(90, 900000, 1000000)],
    ['start', 'fresh', 'fresh', 'close', 'noplan'])
  eq('a 200k window never takes the 1M rule', z(30, 300000, 200000), 'start')
  eq('no percentage yet: no zone', [M.zoneOf({ window: 200000 }), M.zoneOf(null), M.zoneOf({ percent: NaN })], [null, null, null])
  eq('constants match the org guide', [M.START_BELOW, M.SCOPED_UPTO, M.NO_PLAN_FROM, M.LARGE_WINDOW, M.FOLLOW_ON_PAST], [35, 60, 85, 1000000, 200000])

  const yes = [TREE, 'python3 harness_gates.py --tree', 'py "C:/r/scripts/harness/harness_gates.py" --tree',
    'cd /c/r && python scripts/harness/harness_gates.py --tree', 'python scripts/harness/harness_gates.py --staged --tree',
    'python -I scripts/harness/harness_gates.py --tree', 'python.exe "C:/Program Files/h/harness_gates.py" --tree',
    'scripts/harness/harness_gates.py --tree', 'sed -i s/a/b/ f.md && python harness_gates.py --tree', '& python harness_gates.py --tree',
    'python harness_gates.py --tree 2>&1 | tail -1', 'python harness_gates.py --tree 2>&1', 'python harness_gates.py --tree 2>/dev/null | head -3',
    'python harness_gates.py --tree 2>&1 | Select-Object -Last 1', 'python harness_gates.py --tree | Out-String',
    'python harness_gates.py --tree; echo "exit $?"', 'python harness_gates.py --tree 2>$null; Write-Host done',
    'python harness_gates.py --tree 2>&1 | head -n 5', 'python harness_gates.py --tree | Select-Object -Last 1 | Out-String']
  const no = ['python scripts/harness/harness_gates.py', 'python harness_gates.py --tree-x', 'python harness_gates.py; echo --tree',
    'python harness_gates.pyc --tree', 'python harness_gates.py --all', 42, undefined,
    'python harness_gates.py --tree | tee out.txt', 'python harness_gates.py --tree 2>&1 > out.txt', 'python harness_gates.py --tree; Remove-Item x',
    'python harness_gates.py --tree | sort > x', 'python harness_gates.py --tree || python gen.py', 'python harness_gates.py --tree; echo x > f',
    'python harness_gates.py --tree && python gen.py > docs/x.md', 'python harness_gates.py --tree | grep tree',
    'python harness_gates.py --tree | sort -o f.txt', 'python harness_gates.py --tree | cat saved.log',
    'python harness_gates.py --tree | tail -1 saved.log', 'python harness_gates.py --tree; echo "tree: ' + 'a'.repeat(40) + '"',
    'python harness_gates.py --tree; echo \\" ; rm f ; echo \\"', 'python harness_gates.py --tree \\" ; rm f',
    "python harness_gates.py --tree 'x;rm f'", 'python harness_gates.py --tree | Select-String tree',
    'python harness_gates.py --tree; git checkout -- f', 'echo harness_gates.py --tree', "git log --grep 'harness_gates.py --tree'",
    'grep -r "harness_gates.py --tree" docs', 'python harness_gates.py --tree > out.txt', 'python $(echo harness_gates.py) --tree',
    'cat harness_gates.py --tree', 'echo "foo; python harness_gates.py --tree extra"',
    'git commit -m "x | python harness_gates.py --tree --json"', 'git commit -m "msg\npython harness_gates.py --tree passed"',
    "Write-Output 'x; python harness_gates.py --tree ok'", 'echo "a \\" ; python harness_gates.py --tree"']
  eq('isTreeRun: every --tree spelling', yes.map(M.isTreeRun), yes.map(() => true))
  eq('isTreeRun: nothing else', no.map(M.isTreeRun), no.map(() => false))

  // ADR 0139: the PowerShell reads the module holds read-only itself.
  const reads = ['Get-Location', 'Get-ChildItem -Name docs | Select-Object -First 3', 'git status --short',
    "git log --oneline -3 -- 'docs/x y.md'", 'cd C:\\repo; git diff --stat', 'git -C C:\\repo\\sub show --stat HEAD',
    'Get-Content "C:\\Program Files\\x\\a.txt" -Tail 15', "Select-String -Path a.md -Pattern '^\\$x|(y)' | Out-String -Width 200",
    "Get-Content a.md; '---'; Get-Content b.md", 'Get-ChildItem $env:USERPROFILE\\Downloads -Filter "*.pdf"',
    'Where-Object Name -like "*.md"', 'GET-CONTENT a.md | measure', 'git rev-parse HEAD && git ls-files -z',
    'Get-Location' + String.fromCharCode(13, 10) + 'git status', '"it\'s"', "'a''b'", 'Select-String -Pattern "a""b" x.md',
    'Get-Content "C:\\dir\\"', 'Write-Output "$env:USERPROFILE\\x"', "Get-Content '$(not run)'", '"a""b"', '"=====ENV====="']
  const writes = ['Set-Content a.md x', 'Get-Content a.md > b.md', 'Get-Content a.md | Out-File b.md', 'Get-ChildItem | Remove-Item',
    'Get-ChildItem | ForEach-Object Delete', '% Line', 'Get-Content $(Remove-Item x)', 'Get-Content ${x}', 'Get-Content @(1)',
    'Get-Content "$(rm x)"', '"exit=$LASTEXITCODE"', 'Get-Content a.md # it\'s\nRemove-Item b', 'Get-Content "a\\" ; Remove-Item b ; echo "c"',
    'Get-Content \u2018a\u2019; Remove-Item b', 'Get-Content "a', "Get-Content 'a", 'Get-Content a`; Remove-Item b',
    'git add -A', 'git -c core.pager=x log', 'git -C sub -c core.pager=x log', 'git -C sub', 'git diff --output=x.txt', 'git branch new',
    'python gen.py', 'pwsh -File x.ps1', '& ./x.ps1', '[IO.File]::WriteAllText("a","b")', 'Get-Content a | Set-Content b',
    'Get-Content [ab].md', '', '   ', 42, undefined,
    // review findings of the ADR 0139 slice: a quote of the other kind, the call operator, a bare CR, git programs
    'echo "\'" $(Remove-Item x) "\'"', 'Write-Output "a\'$(Remove-Item f)\'b"', "& 'C:\\x\\build.ps1'", '& "x.exe"', "& 'x'",
    'Get-Location &', "Get-Location; & 'x.ps1'", 'Get-Location' + String.fromCharCode(13) + 'Remove-Item x',
    'Get-Location' + String.fromCharCode(0x2028) + 'Remove-Item x', 'Get-Location' + String.fromCharCode(0x85) + 'Remove-Item x',
    'git log ' + String.fromCharCode(0x2013) + '-output=x', 'git diff --ext-diff', 'git show --textconv HEAD', 'git status --% x',
    "Remove-Item'x'", 'Remove-Item"x"', '"git" status', '. ./x.ps1', 'Write-Output "a`$(rm x)"', 'Get-Content "a$x"',
    // the bounded re-review: an operator after a leading string is an expression; git reads env values raw
    "'C:\\x.ts'-as'IO.StreamWriter'", "gc x; 'p'-as'IO.StreamWriter'", '"p"-as"IO.StreamWriter"', "'a'\"b\"", "'a'b",
    'git diff $env:X', 'git log -p "$env:X"', 'git -C $env:R status']
  eq('isPwshReadOnly: the reads', reads.map(M.isPwshReadOnly), reads.map(() => true))
  eq('isPwshReadOnly: everything else counts', writes.map(M.isPwshReadOnly), writes.map(() => false))

  eq('normPath: slashes, trailing slash, drive-letter case',
    [M.normPath('C:\\Repo\\a.md'), M.normPath('c:/repo/'), M.normPath('/home/u/Repo/'), M.normPath('C:/'), M.normPath('')],
    ['c:/repo/a.md', 'c:/repo', '/home/u/Repo', 'c:/', null])
  eq('underRoot: inside, the root itself, a sibling prefix, outside',
    [M.underRoot('C:\\repo\\x\\y.md', 'C:/repo'), M.underRoot('C:/repo', 'c:/REPO'), M.underRoot('C:/repo2/a', 'C:/repo'), M.underRoot('C:/tmp/a', 'C:/repo')],
    [true, true, false, false])
  eq('underRoot: a POSIX path stays case-sensitive', M.underRoot('/home/U/a', '/home/u'), false)
  eq('hasTreeLine: the snapshot line in text or stdout, nothing else',
    [M.hasTreeLine({ text: 'x\n' + TREE_LINE }), M.hasTreeLine({ result: { stdout: TREE_LINE } }), M.hasTreeLine({ text: 'tree: FAILED' }),
      M.hasTreeLine({ text: 'usage: harness_gates.py [--tree]' }), M.hasTreeLine({ text: 'subtree: ' + 'a'.repeat(40) }), M.hasTreeLine(null)],
    [true, true, false, false, false, false])
  eq('hasTreeLine: the LAST tree: line decides',
    [M.hasTreeLine({ text: TREE_LINE + '\ntree: FAILED' }), M.hasTreeLine({ text: 'tree: FAILED\r\n' + TREE_LINE + '\r\n' })],
    [false, true])
  eq('splitSimple: && || | ; and a redirection & stay apart',
    M.splitSimple('a && b || c | d; e 2>&1 &>f').map(x => [x.sep, x.text.trim()]),
    [['', 'a'], ['&&', 'b'], ['||', 'c'], ['|', 'd'], [';', 'e 2>&1 &>f']])

  eq('statusText: nothing to show', M.statusText(null, null), undefined)
  eq('statusText: zone only', M.statusText({ percent: 24.4, tokens: 48800, window: 200000 }, null), 'ctx 24%: 새 슬라이스 시작 가능')
  eq('statusText: fresh tree', M.statusText(null, { files: 0, shell: 0 }), '--tree 이후 변경 없음')
  eq('statusText: both halves, both counts',
    M.statusText({ percent: 62, tokens: 124000, window: 200000 }, { files: 3, shell: 2 }),
    'ctx 62%: 새 슬라이스 말고 닫기 · --tree 이후 파일 3개 수정, 셸 명령 2회 — 다시 실행')
  eq('statusText: shell count alone', M.statusText(null, { files: 0, shell: 1 }), '--tree 이후 셸 명령 1회 — 다시 실행')
}

// --- tracker ---
{
  const T = M.createTracker()
  const call = (e, r = ok()) => T.call(e, r, ROOT)
  // a shell call the way the engine half drives it: `begin` before `next`, `call` with its token after
  const shellRun = (command, r = ok(), tool = 'Bash') => { const e = { tool, command }; return T.call(e, r, ROOT, T.begin(e)) }
  call({ tool: 'Edit', file_path: 'C:/repo/a.md' }); shellRun('make all')
  eq('before --tree: edits and shell calls are not counted and there is no state', T.state(), null)
  eq('a failed --tree run does not arm', [shellRun(TREE, ok(FAILED_TREE)), T.state()], [false, null])
  eq('a --tree-shaped run that printed no tree line does not arm', [shellRun('python harness_gates.py --help --tree', ok({ text: 'usage: ...' })), T.state()], [false, null])
  eq('a denied --tree run does not arm', [shellRun(TREE, { deny: 'no' }, 'PowerShell'), T.state()], [false, null])
  shellRun(TREE, ok(), 'PowerShell')
  eq('a --tree run arms a zero count', T.state(), { files: 0, shell: 0 })
  call({ tool: 'Edit', file_path: 'C:\\repo\\a.md' }); call({ tool: 'Write', file_path: 'c:/REPO/a.md' })
  call({ tool: 'NotebookEdit', notebook_path: 'C:/repo/n.ipynb' })
  eq('distinct files under the root, any spelling', T.state(), { files: 2, shell: 0 })
  call({ tool: 'Edit', file_path: 'C:/scratch/x.md' }); call({ tool: 'Edit', file_path: 'C:/repo/b.md' }, ok({ isError: true }))
  call({ tool: 'Write', file_path: 'C:/repo/c.md' }, { deny: 'no' }); call({ tool: 'Read', file_path: 'C:/repo/d.md' })
  eq('outside the root, failed, denied and read-only tools do not count', T.state(), { files: 2, shell: 0 })
  shellRun('git status', ok({ isReadOnly: true })); shellRun('pwsh docs/build.ps1')
  shellRun('Remove-Item x', ok(), 'PowerShell'); shellRun('rm x', { deny: 'no' })
  eq('shell calls without isReadOnly count; read-only and denied ones do not', T.state(), { files: 2, shell: 2 })
  shellRun('Get-Location', ok(), 'PowerShell'); shellRun('git status', ok(), 'PowerShell')
  eq('a PowerShell read in the ADR 0139 list does not count without the engine mark', T.state(), { files: 2, shell: 2 })
  shellRun('Get-Location', ok())
  eq('the list is PowerShell-only: a Bash call without the mark counts', T.state(), { files: 2, shell: 3 })
  shellRun('sed -i s/a/b/ f && pytest', ok({ isError: true }))
  eq('a FAILED shell call counts: it can write before it fails', T.state(), { files: 2, shell: 4 })
  shellRun(TREE, ok(FAILED_TREE))
  eq('a failed --tree run while armed counts as a shell call, never as a reset', T.state(), { files: 2, shell: 5 })
  shellRun('python harness_gates.py --tree && python gen.py > docs/x.md')
  eq('a --tree run with a command after it is a shell call, not a reset', T.state(), { files: 2, shell: 6 })
  shellRun('python scripts/harness/harness_gates.py --tree 2>&1 | tail -1')
  eq('a new --tree run starts a new count, piped through a filter too', T.state(), { files: 0, shell: 0 })

  // a parallel batch: the --tree run starts, an Edit and a shell call complete, then the run completes
  const e = { tool: 'Bash', command: TREE }
  const tok = T.begin(e)
  call({ tool: 'Edit', file_path: 'C:/repo/late.md' }); shellRun('touch y')
  T.call(e, ok(), ROOT, tok)
  eq('changes that complete while a --tree run is in flight survive its arming', T.state(), { files: 1, shell: 1 })
  call({ tool: 'Edit', file_path: 'C:/repo/early.md' })
  const tok2 = T.begin(e)
  T.call(e, ok(), ROOT, tok2)
  eq('changes that complete before the --tree run starts are dropped by it', T.state(), { files: 0, shell: 0 })
  call({ tool: 'Edit', file_path: 'C:/repo/same.md' })
  const tok3 = T.begin(e)
  call({ tool: 'Edit', file_path: 'C:/repo/same.md' })
  T.call(e, ok(), ROOT, tok3)
  eq('a file changed before AND during the run counts once', T.state(), { files: 1, shell: 0 })
  // two overlapping runs: A starts, an Edit completes, B starts and completes, A completes last
  shellRun(TREE)
  const tA = T.begin(e)
  call({ tool: 'Edit', file_path: 'C:/repo/mid.md' })
  const tB = T.begin(e)
  T.call(e, ok(), ROOT, tB)
  eq('a later run keeps a change made after an OLDER run still in flight', T.state(), { files: 1, shell: 0 })
  T.call(e, ok(), ROOT, tA)
  eq('...and the older run, completing last, keeps it too', T.state(), { files: 1, shell: 0 })

  T.call({ tool: 'Edit', file_path: 'D:/other/a.md' }, ok(), 'D:/other')
  eq('a moved project root drops the count', T.state(), null)
  shellRun(TREE)
  eq('the call that finds the root moved reports a change', T.call({ tool: 'Glob' }, ok(), 'D:/other'), true)
  shellRun(TREE); T.reset()
  eq('reset drops the count', T.state(), null)
  const tok4 = T.begin(e); T.drop(tok4); shellRun('touch z')
  eq('a dropped start leaves nothing recording', [T.call(e, ok(), ROOT, tok4), T.state()], [false, null])
  eq('a malformed event or result is ignored', [T.call(null, ok(), ROOT), T.call({ tool: 'Bash', command: TREE }, null, ROOT, T.begin({ tool: 'Bash', command: TREE })), T.state()], [false, false, null])
  const C = M.createTracker()
  C.call({ tool: 'Bash', command: TREE }, ok(), ROOT, C.begin({ tool: 'Bash', command: TREE }))
  for (let i = 0; i < M.MAX_ENTRIES + 50; i++) { C.call({ tool: 'Write', file_path: `C:/repo/f${i}` }, ok(), ROOT); C.call({ tool: 'Bash', command: 'x' }, ok(), ROOT) }
  eq('memory is capped per kind', C.state(), { files: M.MAX_ENTRIES, shell: M.MAX_ENTRIES })
  const tC = C.begin({ tool: 'Bash', command: TREE })
  C.call({ tool: 'Write', file_path: 'C:/repo/after-cap.md' }, ok(), ROOT); C.call({ tool: 'Bash', command: 'y' }, ok(), ROOT)
  C.call({ tool: 'Bash', command: TREE }, ok(), ROOT, tC)
  eq('at the cap the oldest entry leaves, so a change after the start survives', C.state(), { files: 1, shell: 1 })
}

// --- engine half ---
{
  const E = engine()
  const m = await measure(E, { percent: 40, tokens: 80000, window: 200000 })
  eq('session.measure passes the event and returns next\'s result', [m.passed, m.same], [true, true])
  eq('session.measure pins the zone', E.shown(), 'ctx 40%: 범위 정한 슬라이스만 시작')
  await measure(E, { percent: 40, tokens: 80100, window: 200000 })
  eq('an unchanged line is not pinned again', E.lines.length, 1)
  const t = await tool(E, { tool: 'Bash', command: TREE, tool_use_id: 'u1' }, ok())
  eq('tool.call passes the event and returns next\'s result', [t.passed, t.same], [true, true])
  eq('a --tree run adds the fresh half', E.shown(), 'ctx 40%: 범위 정한 슬라이스만 시작 · --tree 이후 변경 없음')
  await tool(E, { tool: 'Edit', file_path: 'C:/repo/plugins/x.mjs', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' }, ok())
  await tool(E, { tool: 'Bash', command: 'echo SECRET-CMD > f' }, ok())
  eq('edits and a shell write show as counts', E.shown(), 'ctx 40%: 범위 정한 슬라이스만 시작 · --tree 이후 파일 1개 수정, 셸 명령 1회 — 다시 실행')
  eq('the line never carries command, path or edit text', E.lines.some(l => /SECRET|plugins\/x|echo/.test(l ?? '')), false)
  const d = await tool(E, { tool: 'Edit', file_path: 'C:/repo/y.md' }, { deny: 'refused' })
  eq('a denied call passes through untouched', [d.passed, d.same], [true, true])
  const g = await tool(E, { tool: 'Glob', pattern: '*' }, ok())
  eq('another tool passes through and pins nothing new', [g.passed, g.same, E.lines.length], [true, true, 4])
  const c = await through(E, 'session.end', { reason: 'clear', sessionId: 's', resume: {} }, { done: true })
  eq('a /clear passes through, clears the line and the count', [c.passed, c.same, E.shown()], [true, true, undefined])
  await tool(E, { tool: 'Edit', file_path: 'C:/repo/z.md' }, ok())
  eq('after a /clear an edit shows nothing until the next --tree', E.lines.length, 5)
  const x = await through(E, 'session.end', { reason: 'exit', sessionId: 's', resume: {} }, { done: 1 })
  eq('another session end passes through and draws nothing', [x.passed, x.same, E.lines.length], [true, true, 5])
}
{
  const E = engine({ adopted: new Set() })
  await measure(E, { percent: 70, tokens: 140000, window: 200000 })
  await tool(E, { tool: 'Bash', command: TREE }, ok())
  eq('no .harness.json at the root: nothing is pinned', E.lines.length, 0)
  E.adopted.add(ROOT)
  await measure(E, { percent: 70, tokens: 140000, window: 200000 })
  eq('a .harness.json created mid-session is not read before a /clear', E.lines.length, 0)
  await through(E, 'session.end', { reason: 'clear', sessionId: 's', resume: {} }, {})
  await measure(E, { percent: 70, tokens: 140000, window: 200000 })
  eq('after a /clear the root is read again', E.shown(), 'ctx 70%: 새 슬라이스 말고 닫기')
}
{
  const E = engine({ failRoot: 1, failStatus: 1 })
  const m = await measure(E, { percent: 10, tokens: 1, window: 200000 })
  const t = await tool(E, { tool: 'Bash', command: TREE }, ok())
  eq('a failing engine call never reaches the call', [m.same, t.same], [true, true])
  eq('after a failed status pin the next change pins again', E.shown(), undefined)
  await measure(E, { percent: 50, tokens: 1, window: 200000 })
  eq('the line recovers on the next change', E.shown(), 'ctx 50%: 범위 정한 슬라이스만 시작 · --tree 이후 변경 없음')
}
{
  const E = engine({ failExists: 1 })
  const t = await tool(E, { tool: 'Bash', command: TREE }, ok())
  eq('a failing fs.exists never reaches the call and pins nothing', [t.same, t.passed, E.lines.length], [true, true, 0])
  await tool(E, { tool: 'Bash', command: TREE }, ok())
  eq('the next call reads the root again', E.shown(), '--tree 이후 변경 없음')
}
{
  const E = engine()
  const boom = new Error('tool crashed')
  let caught = null
  try { await E.hooks['tool.call'](E.$, deepFreeze({ tool: 'Bash', command: TREE }), async () => { throw boom }) } catch (err) { caught = err }
  eq('a next that throws: the same error reaches the caller', caught === boom, true)
  await tool(E, { tool: 'Bash', command: 'touch q' }, ok())
  eq('...and its dropped start leaves nothing recording', E.lines.length, 0)
}
{
  const E = engine({ adopted: new Set([ROOT, 'D:/other']) })
  await tool(E, { tool: 'Bash', command: TREE }, ok())
  E.setRoot('D:/other')
  await tool(E, { tool: 'Edit', file_path: 'D:/other/a.md' }, ok())
  eq('a /cd to another adopted root drops the --tree half', E.shown(), undefined)
}
{
  const E = engine()
  await measure(E, { percent: 20, tokens: 40000, window: 200000 })
  await tool(E, { tool: 'Bash', command: TREE }, ok())
  E.setRoot('C:/elsewhere')
  await tool(E, { tool: 'Edit', file_path: 'C:/elsewhere/a.md' }, ok())
  eq('a /cd to a root without .harness.json clears the line', E.shown(), undefined)
  await measure(E, { percent: 25, tokens: 50000, window: 200000 })
  eq('...and a measure there pins nothing', [E.shown(), E.lines.length], [undefined, 3])
}

// --- the entry ---
{
  const evs = []
  ENTRY.register((ev, a, b) => { evs.push(ev); return { catch() {} } }, {})
  // ADR 0140: the status line is off; the entry registers the ledger alone.
  eq('mods.mjs registers the ledger only, each hook once (the status line is unregistered)',
    evs.slice().sort(), ['agent.spawn', 'turn.complete', 'turn.step'])
}

for (const [n, v] of results) console.log(n + '\t' + v)
'@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("slice-status-probe-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
$ok = $true
try {
    [IO.File]::WriteAllText($tmp, $probe, [Text.UTF8Encoding]::new($false))
    $raw = (& node $tmp $mod $entry 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $lines = @($raw -split "`r?`n" | Where-Object { $_ -match "`t" })
    if ($code -ne 0 -or $lines.Count -eq 0) { Write-Host "FAIL probe exited $code`n$raw" -ForegroundColor Red; $ok = $false }
    foreach ($l in $lines) {
        $name, $verdict = $l -split "`t", 2
        $ok = (Assert-True $name ($verdict -eq 'OK') $verdict) -and $ok
    }
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }

if (-not $ok) { Write-Host 'slice-status selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host "slice-status selftest: all $($lines.Count) checks passed" -ForegroundColor Green
exit 0
