// Self-test for the plugin's agent definitions (ADR 0100, ADR 0109).
// Usage: node --test-reporter=<file URL of ../lib/selftest-reporter.mjs> --test-reporter-destination=stdout agents/agents.selftest.mjs
//
// No other suite reads the pins. Every agent's model and effort is a decision (ADR 0025, ADR 0109),
// and a frontmatter edit changes what every Agent-tool spawn costs with nothing else failing.
// The suite enumerates agents/*.md, so an agent added without a decided pin fails here.
// `worker` (sonnet · high) is the delegate on every session model, so no agent pins opus (ADR 0109).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Frontmatter is the lines between the opening '---' and the next '---' line. The body is the rest.
function splitAgent(text) {
  const m = /^---\r?\n(?<fm>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]*)$/u.exec(text)
  if (!m) return null
  const fm = {}
  for (const line of m.groups.fm.split(/\r?\n/u)) {
    const kv = /^(?<k>[A-Za-z]+):\s*(?<v>.*)$/u.exec(line)
    if (kv) fm[kv.groups.k] = kv.groups.v.trim()
  }
  return { fm, body: m.groups.body }
}

// Every pattern takes the i flag, and the *.md listing ignores case.
// Every agent file and its decided pin. An agents/*.md missing here fails A0: deciding its pin is
// part of adding it.
const pins = { worker: 'sonnet/high', verifier: 'sonnet/medium', mech: 'haiku/low' }

// A symlink that resolves to a file counts too, so a linked agent with no pin still fails A0.
// A dangling link resolves to nothing and is no agent.
const isFileEntry = (d) => {
  if (d.isFile()) return true
  if (!d.isSymbolicLink()) return false
  try { return statSync(path.join(here, d.name)).isFile() } catch { return false }
}
const files = readdirSync(here, { withFileTypes: true })
  .filter((d) => isFileEntry(d) && /\.md$/iu.test(d.name)).map((d) => d.name.slice(0, -3)).sort()
const agents = {}
for (const n of Object.keys(pins)) {
  const p = path.join(here, `${n}.md`)
  agents[n] = existsSync(p) ? splitAgent(readFileSync(p, 'utf8')) : null
}

test('A0 every agents/*.md has a decided pin (no unlisted agent)', () => {
  const unlisted = files.filter((f) => !Object.hasOwn(pins, f))
  assert.deepEqual(unlisted, [], `unlisted: ${unlisted.join(', ')}`)
})
for (const n of Object.keys(pins)) {
  test(`A0 ${n}.md exists and parses (frontmatter + body)`, () => { assert.ok(agents[n] !== null) })
}

// A1: the pins as decided, and no agent pins opus or fable (ADR 0109).
for (const n of Object.keys(pins)) {
  test(`A1 ${n} pin is ${pins[n]}`, () => {
    const got = `${agents[n]?.fm.model}/${agents[n]?.fm.effort}`
    assert.equal(got, pins[n], `got ${got}`)
  })
}
// The decided table itself names no opus/fable pin, so adding one to both the table and a file is
// still caught here, not only a file that drifts from the table.
for (const n of Object.keys(pins)) {
  test(`A1 decided pin for ${n} names no opus/fable model`, () => {
    assert.doesNotMatch(pins[n], /opus|fable/iu, `pin: ${pins[n]}`)
  })
}

// A2: every agent denies Agent, because fan-out belongs to the orchestrator.
// The retired worker-opus twin stays retired: no file, and no description routes to it (ADR 0109).
for (const n of Object.keys(pins)) {
  test(`A2 ${n} denies Agent`, () => {
    assert.equal(agents[n]?.fm.disallowedTools, 'Agent', `disallowedTools: ${agents[n]?.fm.disallowedTools}`)
  })
}
// mech runs without the project's and the user's CLAUDE.md (ADR 0079).
test('A2 mech omits CLAUDE.md (ADR 0079)', () => {
  assert.equal(agents.mech?.fm.omitClaudeMd, 'true', `omitClaudeMd: ${agents.mech?.fm.omitClaudeMd}`)
})
test('A2 worker-opus.md is retired (ADR 0109)', () => {
  assert.ok(!existsSync(path.join(here, 'worker-opus.md')))
})
for (const n of Object.keys(pins)) {
  test(`A2 ${n} description names no worker-opus route`, () => {
    assert.doesNotMatch(agents[n]?.fm.description ?? '', /worker-opus/iu)
  })
}

// A3: the routing text a model reads when it picks an agent. The worker description says it serves
// every session model, Opus included, and names neither general-purpose nor ultracode (ADR 0108).
test('A3 worker description says it serves every session model, Opus included', () => {
  const wd = agents.worker?.fm.description ?? ''
  assert.ok(/every session model/iu.test(wd) && /Opus included/iu.test(wd) && !/ultracode|general-purpose/iu.test(wd), `description: ${wd}`)
})
