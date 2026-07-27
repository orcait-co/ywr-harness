// ywr-harness statusline — location · model · effort · context% · rate-limit%, plus terminal
// tab-title sync.
//
// TOOLCHAIN (ADR 0010/0016): this is the canon. `install.ps1` copies it to the user scope and it
// is OVERWRITTEN on every re-run. Do not hand-edit the installed copy — fix it here.
//
// A plugin CANNOT contribute the main status line: a plugin's `settings.json` supports only the
// `agent` and `subagentStatusLine` keys (plugins-reference, "File locations reference"). So this
// ships as canon + an installer that writes the user's own settings, rather than as a component
// Claude Code loads on its own. That constraint is the whole reason ADR 0016 exists.
//
// ## The payload
//
// stdin is the statusline JSON. Keys used, all confirmed against a live 2.1.220 payload
// (2026-07-27) rather than read off the docs:
//
//   model.display_name · effort.level · workspace.current_dir
//   context_window.used_percentage       — context consumed
//   context_window.context_window_size   — window size, a session constant
//   rate_limits.{five_hour,seven_day}.used_percentage   — what /usage shows
//
// A key absent on some version or plan means its segment DISAPPEARS. It is never rendered as
// `0%`: unmeasured and zero are different states, and a status line that says 0% when it does not
// know is worse than one that says nothing. Rate-limit keys are legitimately missing on the first
// render of a session, before the first API response — that is not a regression.
//
// ## Why the model's "(1M context)" is stripped
//
// The window size is constant for the whole session, so spending label width on it every render
// buys nothing; what changes — and what anyone actually wants — is how much of it is gone. The
// size is not discarded, it moves next to the percentage (`ctx 24%/1M`), because 24% of 200k and
// 24% of 1M are different situations and a bare percentage cannot tell them apart.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Display label for the org guide segment. The settings KEY that carries the guide is `claudeMd`
// and is fixed by Claude Code (managed-settings only) — an org cannot rename it, and managed
// settings parse tolerantly, so a renamed key would be stripped with a warning and the guide would
// silently stop being delivered. This label is only what the status line PRINTS.
const GUIDE_LABEL = "orcait-guide";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function seg(label, value, warn, crit) {
  if (typeof value !== "number" || !isFinite(value)) return ""; // absent = not rendered
  const v = Math.round(value);
  const color = v >= crit ? RED : v >= warn ? YELLOW : GREEN;
  return ` ${DIM}·${RESET} ${DIM}${label}${RESET} ${color}${v}%${RESET}`;
}

// Quota: comfortable / watch / close.
const pct = (label, value) => seg(label, value, 50, 80);

// Context has a different curve — 50% is ordinary working state. What matters is nearing the
// point where the window is about to be summarized away.
const ctxPct = (label, value) => seg(label, value, 70, 90);

// 1000000 -> "1M", 200000 -> "200k".
function windowSize(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
  if (n >= 1000000) {
    const m = n / 1000000;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + "M";
  }
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

// "Opus 5 (1M context)" -> "Opus 5". Only a TRAILING parenthetical that mentions `context` is
// removed; "(preview)" and friends carry information and stay.
function stripContextSuffix(name) {
  return String(name).replace(/\s*\([^()]*\bcontext\b[^()]*\)\s*$/i, "").trim() || String(name);
}

function guideVersion(home) {
    // The version marker of the org guide THIS SESSION ACTUALLY HAS, read from Claude Code's local
    // cache of server-managed settings.
    //
    // Deliberately the DELIVERED value and not the repo's. Reading `claude/org-guide.md` from a
    // clone would show what has been merged, which is exactly the wrong number: the console paste
    // is a manual step (spec 0003 §5), so repo and console routinely disagree, and a status line
    // showing the repo version would report success for a deploy that never happened. Measured
    // 2026-07-27: repo main on v1.3 while every live session was still carrying v1.2.
    //
    // Absent cache, unparseable JSON, or no marker -> empty, and the segment disappears. Same rule
    // as every other segment here: unmeasured is not the same as a value.
    try {
        const p = path.join(home || os.homedir(), ".claude", "remote-settings.json");
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const m = /<!--\s*(v[0-9][0-9.]*)/.exec(String(j.claudeMd || ""));
        return m ? m[1] : "";
    } catch {
        return "";
    }
}

function render(j, guide) {
    if (guide === undefined) guide = guideVersion();
  const cwd =
    (j.workspace && (j.workspace.current_dir || j.workspace.project_dir)) || j.cwd || "";
  const parts = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  const loc = parts.slice(-2).join("/") || cwd || "?";
  const model = stripContextSuffix((j.model && (j.model.display_name || j.model.id)) || "?");
  const effort = (j.effort && j.effort.level) || "";

  const cw = j.context_window || {};
  const size = windowSize(cw.context_window_size);
  const ctxSeg = ctxPct("ctx", cw.used_percentage);

  const rl = j.rate_limits || {};

  return {
    loc,
    model,
    effort,
    line:
      `\x1b[36m${loc}${RESET} ${DIM}·${RESET} \x1b[1m${model}${RESET}` +
      (effort ? ` ${DIM}·${RESET} \x1b[33m${effort}${RESET}` : "") +
      ctxSeg +
      // The size rides along only when the percentage actually rendered — a bare "/1M" with no
      // number in front of it is noise.
      (ctxSeg && size ? `${DIM}/${size}${RESET}` : "") +
      pct("5h", rl.five_hour && rl.five_hour.used_percentage) +
      pct("7d", rl.seven_day && rl.seven_day.used_percentage) +
      // Last. The LABEL is dim like every other label; the VERSION gets magenta — readable
      // without shouting, and deliberately outside the green/yellow/red family so it is never
      // mistaken for a threshold. Dim-on-dim was the first attempt and was simply too faint to
      // read against a dark terminal.
      (guide ? ` ${DIM}·${RESET} ${DIM}${GUIDE_LABEL}${RESET} ${MAGENTA}${guide}${RESET}` : ""),
  };
}

// Exported for the selftest, which asserts on render() directly rather than on a spawned process:
// a status line is a pure function of its payload, and testing it through stdio would measure the
// harness more than the renderer.
module.exports = { render, stripContextSuffix, windowSize, seg, guideVersion, GUIDE_LABEL };

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let j = {};
    try {
      j = JSON.parse(raw || "{}");
    } catch {}
    const r = render(j);

    // Tab title: location/model/effort. Usage percentages are deliberately NOT in the title —
    // they change on every render and would make the tab flicker.
    const title = `${r.loc}/${r.model}${r.effort ? "/" + r.effort : ""}`;
    try {
      process.title = title; // Windows: SetConsoleTitle
    } catch {}
    try {
      const out = fs.openSync("\\\\.\\CONOUT$", "w"); // WT/conhost VT: OSC 0 sets window/tab title
      fs.writeSync(out, `\x1b]0;${title}\x07`);
      fs.closeSync(out);
    } catch {
      // Absent on non-Windows and on redirected consoles. Best effort by design: a status line
      // must never fail because a terminal would not take a title.
    }
  process.stdout.write(r.line);
  });
}
