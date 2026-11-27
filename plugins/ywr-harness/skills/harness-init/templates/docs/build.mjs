// docs-as-code build: regenerates four outputs from the .md files (with frontmatter) in docs/adr and docs/spec.
// It runs build_docs.mjs from the same folder. The outputs are:
//   index.json         structured metadata and the dependency graph, for agents and machines
//   INDEX.md           a short table of contents, for people and agents
//   docs.html          one browsable page, for people
//   docs.artifact.html a claude.ai Artifact fragment
// The .md files are the source. Edit them, then run this file again. Never edit an output by hand.
//
// Usage: node docs/build.mjs   (Node 22 or later, built-in modules only)
//
// Copyright (c) 2026 YWR Labs Inc. All rights reserved.
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// The builder runs in a child of the current Node, so no PATH lookup happens and its output passes through.
const r = spawnSync(process.execPath, [path.join(here, 'build_docs.mjs')], { stdio: 'inherit' })
// Pass the child's exit code on. A duplicate id is a build failure (ywr-harness ADR 0043), and a wrapper
// that turned it into 0 would drop the gate on the path a person runs. A start failure or a signal exit is 1.
process.exitCode = r.error ? 1 : (r.status ?? 1)
