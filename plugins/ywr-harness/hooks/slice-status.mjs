// Hooks module (Claude Mods; ADR 0138) — the OBSERVE-ONLY slice status line. `mods.mjs` registers it
// beside `delegation-ledger.mjs`; `hooks.json` names that entry under `modules`.
//
// One line, pinned under the prompt by `$.ui.status` (one per plugin, beside the engine's notices; the
// member's own statusline is untouched), with two halves:
//
// - the CONTEXT ZONE, from `session.measure`: the org guide's start rule (under ~35 % start freely,
//   35–60 % only a scoped slice, over 60 % close, past ~85 % plan nothing new; in a 1M window, a
//   follow-on phase past ~200k tokens starts in a fresh session). The higher zone wins.
// - the `--tree` FRESHNESS of the prepared close (ADR 0105: the ready report's last line is what
//   `harness_gates.py --tree` printed after the final edit), from `tool.call`: after a successful
//   `--tree` run (a shell call that ENDS with it, `isTreeRun`), the distinct files under the project
//   root an Edit / Write / NotebookEdit changed, and the Bash / PowerShell calls the engine did not mark
//   `isReadOnly`, failed ones included. Before the first `--tree` run there is no `--tree` half, and a
//   reset (a /clear, a root move, a lost worker) drops it again, so a lost count never reads as "no
//   change"; the residuals ADR 0138 lists are writes the module cannot see.
//
// Observe-only, by contract (ADR 0117's, narrowed by ADR 0138 to allow `$.ui.status` alone): every hook
// hands `next` the event it received and returns what `next` resolved to; the bookkeeping runs after
// `next`, inside try/catch, except one in-memory mark of a `--tree` run's start before `next`. It never denies, rewrites, starts a turn or writes a file, and the line
// carries no prompt, command or file text — counts and the zone only. It runs only where the project
// root holds `.harness.json` (the ledger's rule).
//
// The thresholds are constants: the org guide (claude/org-guide.md, "Session hygiene") is their source,
// and a guide change to the zones changes them in the same slice (ADR 0138 Decision 7).
//
// The pure half (`zoneOf`, `isTreeRun`, `normPath`, `underRoot`, `createTracker`, `statusText`) is
// exported so `slice-status.selftest.ps1` drives it under plain node with a fake engine; the engine
// imports only `register`.

export const START_BELOW = 35        // percent: under this, start freely
export const SCOPED_UPTO = 60        // percent: 35..60 inclusive, a scoped slice only; above, close
export const NO_PLAN_FROM = 85       // percent: from this, plan nothing new
export const LARGE_WINDOW = 1000000  // tokens: a window this size or larger takes the follow-on rule
export const FOLLOW_ON_PAST = 200000 // tokens: past this in a large window, the next phase is a new session

// Zones in rising order; the line shows the highest that applies.
export const ZONES = ['start', 'scoped', 'fresh', 'close', 'noplan']
const ZONE_TEXT = {
  start: '새 슬라이스 시작 가능',
  scoped: '범위 정한 슬라이스만 시작',
  fresh: '다음 단계는 새 세션에서',
  close: '새 슬라이스 말고 닫기',
  noplan: '새 계획 금지',
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const isNum = x => typeof x === 'number' && Number.isFinite(x)

// The zone of one context reading ({ percent, tokens, window }), or null with no percentage yet.
export function zoneOf(ctx) {
  if (!ctx || typeof ctx !== 'object' || !isNum(ctx.percent)) return null
  const p = ctx.percent
  let z = p >= NO_PLAN_FROM ? 'noplan' : p > SCOPED_UPTO ? 'close' : p >= START_BELOW ? 'scoped' : 'start'
  if (isNum(ctx.window) && ctx.window >= LARGE_WINDOW && isNum(ctx.tokens) && ctx.tokens > FOLLOW_ON_PAST &&
    ZONES.indexOf(z) < ZONES.indexOf('fresh')) z = 'fresh'
  return z
}

// The head of a `--tree` run: an optional `python` / `python3` / `py` with flags, then the script by any
// path (quoted or bare), then its arguments.
const TREE_RUN = /^(?:(?:python3?|py)(?:\.exe)?\s+(?:-[A-Za-z]\S*\s+)*)?(?:"[^"]*harness_gates\.py"|'[^']*harness_gates\.py'|[^\s"']*harness_gates\.py)((?:\s+\S+)*)$/
// Redirections a `--tree` run may carry: stderr folded into stdout or discarded. Any other redirection
// writes a file, so the run is not recognised.
const STDERR_ONLY = /(?:^|\s)2>(?:&1|\s*\/dev\/null|\s*\$null|\s*nul)(?=\s|$)/gi
// Commands that may follow a `--tree` run through a single pipe: filters that cut or format stdin and take
// no operand, so they can neither write a file nor read one (`sort -o`, `cat <log>`, `grep -r` are out).
// Their arguments must be options or numbers (`tail -1`, `head -n 5`, `Select-Object -Last 3`).
const PIPE_FILTERS = new Set(['tail', 'head', 'select-object', 'select', 'out-string', 'out-host'])
const FILTER_ARG = /^(?:-{1,2}[A-Za-z][\w-]*|-?\d+)$/
// Commands that may follow it through any separator: they only print. One that prints `tree:` itself is
// not one of them, since it could forge the line `hasTreeLine` reads.
const PRINTERS = new Set(['echo', 'printf', 'write-output', 'write-host'])
// The arguments of the run itself: plain flags and values only (`--tree`, `--staged`), so no quote,
// backslash or separator can hide a second command inside them.
const RUN_ARG = /^[\w\-.=:/]+$/

// A command split into simple commands at a newline, `;`, `&&`, `||`, `&` or `|` OUTSIDE quotes, each with
// the separator before it ('' for the first). A separator inside '…' or "…" (a commit message, an echoed
// string) never splits; a backslash inside "…" escapes the next character; an unclosed quote runs to the
// end. An `&` that touches a `>` (`2>&1`, `&>`) belongs to a redirection, not a separator.
export function splitSimple(command) {
  const out = []
  let cur = ''
  let sep = ''
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const n = command[i + 1]
    if (quote) {
      cur += c
      if (quote === '"' && c === '\\' && i + 1 < command.length) cur += command[++i]
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") { quote = c; cur += c }
    else if (c === '&' && (cur.endsWith('>') || n === '>')) cur += c
    else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      out.push({ sep, text: cur })
      sep = (c === '&' || c === '|') && n === c ? (i++, c + c) : c
      cur = ''
    } else cur += c
  }
  out.push({ sep, text: cur })
  return out
}

// Whether a shell command's LAST effective step is a `harness_gates.py --tree` run (ADR 0138): one simple
// command runs the script (directly or through python / python3 / py) with `--tree` as an argument and no
// redirection beyond stderr; every simple command after it is a filter reached by a single pipe or a
// printer; none holds a redirection or a substitution. Commands before it are free (`cd … &&`): the tree
// line it prints already covers what they did. This is the SHAPE alone: `hasTreeLine` must also find the
// tree line in the call's output before the count resets.
export function isTreeRun(command) {
  if (typeof command !== 'string') return false
  const segs = splitSimple(command).filter(s => s.text.trim())
  for (let i = segs.length - 1; i >= 0; i--) {
    const text = segs[i].text.trim()
    const bare = text.replace(STDERR_ONLY, ' ').trim()
    if (!/[<>`$()]/.test(bare)) {
      const m = TREE_RUN.exec(bare)
      const args = m ? m[1].trim().split(/\s+/).filter(Boolean) : []
      if (m && args.includes('--tree') && args.every(a => RUN_ARG.test(a))) return true
    }
    // not the run: it must be a harmless tail, or the command ends with something else. A backslash or a
    // backtick is refused here: shells disagree on what it escapes, so the split could be wrong.
    if (/[<>`\\]|\$\(/.test(text)) return false
    const words = text.split(/\s+/)
    const w = words[0].toLowerCase()
    const printer = PRINTERS.has(w) && !/tree:/i.test(text)
    const filter = segs[i].sep === '|' && PIPE_FILTERS.has(w) && words.slice(1).every(a => FILTER_ARG.test(a))
    if (!(printer || filter)) return false
  }
  return false
}

// Whether a call's output ENDS its `tree:` lines with the one `harness_gates.py --tree` prints for a
// snapshot it took: `tree: <hex id> · HEAD …`. The LAST `tree:` line decides, so a failed run's
// `tree: FAILED` outweighs an older line that a command before it printed; `--help` prints none.
export function hasTreeLine(r) {
  if (!r || typeof r !== 'object') return false
  const texts = [r.text, r.result && typeof r.result === 'object' ? r.result.stdout : undefined]
  return texts.some(t => {
    if (typeof t !== 'string') return false
    const lines = t.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('tree:'))
    return lines.length > 0 && /^tree: [0-9a-f]{40,64}\b/.test(lines[lines.length - 1])
  })
}

// A path in one spelling: forward slashes, no trailing slash, and lower case for a drive-letter path
// (Windows paths compare case-insensitively).
export function normPath(p) {
  if (typeof p !== 'string' || !p) return null
  let s = p.split('\\').join('/')
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s
}

export function underRoot(path, root) {
  const p = normPath(path), r = normPath(root)
  if (!p || !r) return false
  return p === r || p.startsWith(r.endsWith('/') ? r : r + '/')
}

// Entries one tracker keeps at most: distinct files and counted shell calls each.
export const MAX_ENTRIES = 10000

// One session's `--tree` bookkeeping, engine-free. `begin(e)` runs BEFORE `next` and marks the start of a
// `--tree` run (its token, or null); `call(e, r, root, token)` takes the call's event, the result `next`
// resolved to and that token; `drop(token)` forgets a start whose call never completed; `state()` answers
// null before the first `--tree` run that printed a tree line, else the counts.
//
// Every completion takes a sequence number. While a `--tree` run is in flight or after one succeeded, the
// tracker records each counted change with its number; a run that succeeds keeps only the changes that
// completed AFTER it started, so an Edit finishing beside a parallel `--tree` run is never wiped.
// A shell call counts unless the engine marked it `isReadOnly` or a hook denied it (a denied call never
// ran); a failed one counts too, since a command can write before it fails.
export function createTracker() {
  let armed = false
  let root = null
  let seq = 0
  const files = new Map()      // normalized path -> sequence number of its last counted change
  const shell = []             // sequence numbers of the counted shell calls
  const inflight = new Map()   // token -> sequence number at the start of a `--tree` run
  const denied = r => !r || typeof r !== 'object' || (typeof r.deny === 'string' && r.deny)
  const failed = r => denied(r) || r.isError === true
  const reset = () => { armed = false; root = null; files.clear(); shell.length = 0; inflight.clear() }
  return {
    begin(e) {
      if (!e || typeof e !== 'object' || !SHELL_TOOLS.has(String(e.tool)) || !isTreeRun(e.command)) return null
      const t = ++seq
      inflight.set(t, t)
      return t
    },
    drop(token) { inflight.delete(token) },
    call(e, r, sessionRoot, token = null) {
      const start = token === null ? undefined : inflight.get(token)
      if (token !== null) inflight.delete(token)
      if (!e || typeof e !== 'object') return false
      const s = ++seq
      const tool = String(e.tool)
      const rootN = normPath(sessionRoot)
      // the project root moved: every count and start mark is dropped, which changes a shown line
      let moved = false
      if (root !== null && rootN !== root) { moved = armed; reset() }
      // A run resets the count only when its output holds a tree line: the exit status of a piped run is
      // the pipe's, and a run that printed no snapshot proves nothing. Otherwise it is a shell call.
      if (start !== undefined && !denied(r) && hasTreeLine(r)) {
        armed = true
        root = rootN
        // Prune below the oldest start still open: a run that started earlier and completes later
        // prints the last tree line, so a change after ITS start must survive this run's arming.
        let cut = start
        for (const q of inflight.values()) if (q < cut) cut = q
        for (const [p, q] of files) if (q < cut) files.delete(p)
        const kept = shell.filter(q => q > cut)
        shell.length = 0
        shell.push(...kept)
        return true
      }
      if (!armed && inflight.size === 0) {
        if (files.size || shell.length) { files.clear(); shell.length = 0; root = null }
        return moved
      }
      if (root === null) root = rootN
      // At the cap the OLDEST entry leaves, never the new one: a change after the latest start is what
      // a later pruning keeps, so dropping it could read as "no change".
      if (SHELL_TOOLS.has(tool)) {
        if (denied(r) || r.isReadOnly === true) return moved
        if (shell.length >= MAX_ENTRIES) shell.shift()
        shell.push(s)
        return armed || moved
      }
      if (EDIT_TOOLS.has(tool) && !failed(r)) {
        const p = tool === 'NotebookEdit' ? e.notebook_path : e.file_path
        if (!underRoot(p, root)) return moved
        const n = normPath(p)
        const had = files.delete(n)   // re-insert, so the map stays in sequence order for eviction
        if (!had && files.size >= MAX_ENTRIES) files.delete(files.keys().next().value)
        files.set(n, s)
        return (armed && !had) || moved
      }
      return moved
    },
    reset,
    state: () => (armed ? { files: files.size, shell: shell.length } : null),
  }
}

// The line for a context reading and a tracker state, or undefined when there is nothing to show.
export function statusText(ctx, tree) {
  const parts = []
  const z = zoneOf(ctx)
  if (z) parts.push(`ctx ${Math.round(ctx.percent)}%: ${ZONE_TEXT[z]}`)
  if (tree) {
    if (tree.files === 0 && tree.shell === 0) parts.push('--tree 이후 변경 없음')
    else {
      const bits = []
      if (tree.files > 0) bits.push(`파일 ${tree.files}개 수정`)
      if (tree.shell > 0) bits.push(`셸 명령 ${tree.shell}회`)
      parts.push(`--tree 이후 ${bits.join(', ')} — 다시 실행`)
    }
  }
  return parts.length ? parts.join(' · ') : undefined
}

// --- the engine half ---------------------------------------------------------------------------
// Declared at the top of the file: the engine follows `$` only into such functions.

// The project root when it holds `.harness.json`, else null; `adopted` caches the answer per root.
async function adoptedRoot($, adopted) {
  const root = await $.session.root()
  if (!adopted.has(root)) adopted.set(root, await $.fs.exists(`${root}/.harness.json`))
  return adopted.get(root) ? root : null
}

// Pins the line when its text changed since the last pin. `shown` moves only after the pin went
// through, so a failed pin is tried again at the next event.
function show($, view) {
  const text = statusText(view.ctx, view.tracker.state())
  if (text === view.shown) return
  $.ui.status(text)
  view.shown = text
}

// Drops the count and the zone and clears a shown line: a /clear, or a root without `.harness.json`.
function away($, view) {
  view.tracker.reset()
  view.ctx = null
  if (view.shown === undefined) return
  $.ui.status(undefined)
  view.shown = undefined
}

export function register(on) {
  const adopted = new Map()   // project root -> whether it holds .harness.json
  const view = { ctx: null, tracker: createTracker(), shown: undefined }

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      if (await adoptedRoot($, adopted)) {
        if (e.context && typeof e.context === 'object') view.ctx = { percent: e.context.percent, tokens: e.context.tokens, window: e.context.window }
        show($, view)
      } else away($, view)
    } catch { /* observe-only: the line never reaches the session */ }
    return r
  })

  on('tool.call', async ($, e, next) => {
    // The only work before `next`: a memory mark of a `--tree` run's start, no engine call.
    let token = null
    try { token = view.tracker.begin(e) } catch { /* observe-only */ }
    let r
    try { r = await next(e) } catch (err) {
      if (token !== null) view.tracker.drop(token)
      throw err
    }
    try {
      const tool = String(e.tool)
      if (EDIT_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) {
        const root = await adoptedRoot($, adopted)
        if (!root) away($, view)
        else if (view.tracker.call(e, r, root, token)) show($, view)
        token = null
      }
    } catch { /* observe-only: never fail the call */ }
    if (token !== null) view.tracker.drop(token)
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.reason === 'clear') {
        adopted.clear()   // a `.harness.json` created or removed before the /clear counts from here
        away($, view)
      }
    } catch { /* observe-only */ }
    return r
  })
}
