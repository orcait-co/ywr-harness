---
name: setup
description: Install the tool ywr-harness needs (node 22+) — on Windows with winget, elsewhere by printing the install commands. Use when the user types the command; the plugin's prerequisite band names it when a tool is missing.
disable-model-invocation: true
---

# setup — install the harness prerequisites

The plugin's hooks module answers this command itself on Claude Code 2.1.287 and later (ywr-harness ADR 0142):
it probes the tools, runs `winget` and reports, with no model turn. You read this body only where
the host dropped the module (an older host, `disableAllHooks`, `--safe-mode`, a managed
`allowManagedModsOnly`). Do the same work by hand. The user typed the command, so the user has
agreed to the installs it names — and to nothing else.

## 1. Probe

Run this once and read its exit code and first line:

```
node --version
```

A tool needs an install when the command is not found, exits non-zero (a Windows Store alias stub
does), or reports `node` below 22. If none needs one, say so and stop.

## 2. Install

On Windows, check `winget --version` first. Without `winget`, tell the user to install "App
Installer" from the Microsoft Store and stop. Otherwise run this line when `node` needs an install:

```
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
```

An install can raise a Windows UAC prompt; tell the user before each run that one may appear,
and that interrupting the run (Esc) may cut the install off part-way — unmeasured. If it was cut
off, the prerequisite band returns at the next session; run the command again.
Exit code `-1978335189` (`0x8A15002B`) means the package is already installed.

Off Windows, install nothing. Print the commands instead: macOS `brew install node`, and
`brew upgrade node` for an old Homebrew install; Linux, a Node 22+ LTS from nodejs.org or a version
manager such as nvm (a distribution's `nodejs` package can be older than 22).

## 3. Report

List the tool with its result. End with: quit Claude Code completely and start it again — a
running session keeps its old `PATH` and cannot see a tool installed after it started.

A winget exit 0 does not prove the command resolves: nobody has measured whether the installer
puts `node` on `PATH`. Say so. If the prerequisite band comes back after the restart, the tool is
installed but not found: check that the Node folder is on `PATH`. If the probe found an OLD
version, winget installs the new one beside it: a returning band then means the old one still comes
first on `PATH` — remove it or reorder `PATH`. A probe that timed out proves nothing either way:
report that tool as not verified, never as installed.
