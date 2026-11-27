// The one reporter of the Node suites (ADR 0227 decision 2). Both runners, the read-set audit and the parity
// script count PASS lines and read signal lines by this line shape:
//   PASS [<test name>]
//   FAIL [<test name>]: <first line of the error message>, then the rest of the message, indented
//   SKIP [<test name>]: <reason>
// A test name starts with the case ID of its suite (ADR 0227 decision 1). The exit code of the suite
// is its verdict; this module only prints.
//
// Start a suite with it as one line (ADR 0227 decision 3):
//   node --test-reporter=<file URL of this module> --test-reporter-destination=stdout <suite.selftest.mjs>
// The option takes a module specifier: an absolute Windows path stops node at load, a file: URL works.
//
// The suite's own stdout reaches this reporter as test:stdout events only under `node --test`; a direct
// run writes it straight to stdout. Both arrive as plain lines, so a suite prints a WARN line with
// console.log in either mode. Diagnostics (t.diagnostic and the run summary) are not printed: the
// summary would add lines that no reader wants, and a suite prints its own signal lines.

const one = (s) => String(s ?? '').replace(/\r?\n+$/u, '')

function failText(details) {
  const err = details?.error
  // node:test wraps a thrown error as ERR_TEST_FAILURE with the original as its cause.
  const inner = err?.cause ?? err
  const msg = one(inner?.message ?? inner ?? 'failed')
  const [head, ...rest] = msg.split(/\r?\n/u)
  const tail = rest.filter((l) => l.trim() !== '').map((l) => `    ${l}`)
  return [head, ...tail]
}

// A reader that counts the PASS, FAIL and SKIP lines of a `node --test` run would count a child run's `FAIL [x]`
// line at column 0. So when YWR_SELFTEST_STDOUT_INDENT is set, the suite's own forwarded output gets that indent
// and never starts a counted line. A direct run has no forwarded output: the suite writes to stdout itself.
const INDENT = process.env.YWR_SELFTEST_STDOUT_INDENT ?? ''
const indent = (msg) => (INDENT ? String(msg).replace(/^(?=.)/gmu, INDENT) : msg)

const skipText = (d) => (d.skip === true ? 'skipped' : one(d.skip))
const todoText = (d, tag) => `todo${tag}${d.todo === true ? '' : ` ${one(d.todo)}`}`

export default async function* selftestReporter(source) {
  for await (const ev of source) {
    const d = ev.data ?? {}
    // A describe() block reports as a test too. Its PASS adds nothing, because its tests printed their
    // own lines. Its SKIP and its own failure, a throw in its body or a hook, have no other line, so
    // both print. A describe that failed only because a test inside it failed prints nothing more.
    const isSuite = d.details?.type === 'suite'
    if (ev.type === 'test:pass') {
      if (d.skip !== undefined) yield `SKIP [${d.name}]: ${skipText(d)}\n`
      else if (d.todo !== undefined && !isSuite) yield `SKIP [${d.name}]: ${todoText(d, '')}\n`
      else if (!isSuite) yield `PASS [${d.name}]\n`
    } else if (ev.type === 'test:fail') {
      if (isSuite && d.details?.error?.failureType === 'subtestsFailed') continue
      // A failing todo test does not fail the run, so it is a SKIP line, never a FAIL line.
      if (d.todo !== undefined) { yield `SKIP [${d.name}]: ${todoText(d, ' (failed)')}\n`; continue }
      const [head, ...tail] = failText(d.details)
      yield `FAIL [${d.name}]: ${head}\n` + tail.map((l) => `${l}\n`).join('')
    } else if (ev.type === 'test:stdout' || ev.type === 'test:stderr') {
      yield indent(d.message)
    }
  }
}
