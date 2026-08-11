// ywr-harness statusline — location · model · effort · context% · rate-limit% · installed
// plugin version, plus terminal tab-title sync.
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

// Display label for the plugin-version segment: the plugin's own manifest name, equally true on
// every machine this file reaches. (This segment replaced the retired org-guide one — the canon
// repo's ADR 0027; guide drift detection belongs to spec 0003 §7, not to a glance surface.)
const PLUGIN_LABEL = "ywr-harness";

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

// The user scope this session runs under: explicit non-empty arg -> CLAUDE_CONFIG_DIR ->
// ~/.claude (ADR 0046; an empty explicit arg counts as absent). Claude Code's registry and
// settings follow the env var, so a canon that read `~/.claude` unconditionally reported the
// OTHER account's install on a multi-account machine. The env value is trusted only when
// ABSOLUTE: a relative value would resolve against whatever cwd the renderer was spawned with,
// making the version segment flicker with the spawn point — so a set-but-malformed value
// returns "" and the caller treats the registry as unmeasured (the segment disappears;
// absent != 0, and falling back to ~/.claude would resurrect the wrong-account read).
function claudeDir(dir, env = process.env) {
  if (dir) return dir;
  const raw = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (raw) return path.isAbsolute(raw) ? raw : "";
  return path.join(os.homedir(), ".claude");
}

// Tab-title head: the config-dir account (`.claude-ywrlabs` -> `claude-ywrlabs`), or "" when no
// CLAUDE_CONFIG_DIR is set. The account is the one session dimension with no other surface —
// `loc` is already the line's first segment — and it is what distinguishes two otherwise
// identical terminals (ADR 0046). Unlike claudeDir(), no absoluteness demand: the label is a
// pure string transform with no filesystem meaning, so the basename of even a relative value is
// still the account the member set. Anything that strips to nothing yields "" and tabTitle()
// falls back to the location — never a bare "/model" title.
function accountLabel(env = process.env) {
  const dir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (!dir) return "";
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/^\./, "");
}

function pluginVersion(dir) {
    // The version of this plugin actually INSTALLED for this account, read from Claude Code's
    // install registry (`<config-dir>/plugins/installed_plugins.json`, resolution above).
    //
    // Deliberately the ON-DISK value, not the running session's: with marketplace auto-update on,
    // disk moves ahead of a live session — and that visible mismatch is exactly the "restart to
    // apply" signal worth surfacing. Same honesty rule the retired org-guide segment followed,
    // one link further down the chain: show what this machine HAS, never what a repo or the
    // marketplace published.
    //
    // Only the plugin name is pinned; the `@marketplace` half of the key is not, because a
    // consuming org may register the marketplace under another name. Absent file, unparseable
    // JSON, no entry, or a version the registry records as "unknown" -> empty, and the segment
    // disappears. Same rule as every other segment here: unmeasured is not the same as a value.
    try {
        const base = claudeDir(dir);
        if (!base) return ""; // set-but-malformed CLAUDE_CONFIG_DIR: unmeasured, never a guess
        const p = path.join(base, "plugins", "installed_plugins.json");
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        // A usable version carries at least one digit. That one shape test subsumes the
        // registry's literal "unknown" sentinel AND the corrupted-write shapes ("v", whitespace)
        // — none of which may render as a confident-looking version.
        const usable = (v) => v != null && /\d/.test(String(v));
        // Several installs can coexist (a project-scope entry alongside the user-scope one).
        // This file is placed machine-wide, so the user-scope entry is the relevant one: prefer
        // it, then break remaining ties by most-recent lastUpdated — never by registry order,
        // which would let a stale project-scope entry listed first shadow the real install.
        let best = null;
        for (const key of Object.keys((j && j.plugins) || {})) {
            if (!key.startsWith("ywr-harness@")) continue;
            for (const inst of [].concat(j.plugins[key] || [])) {
                if (!inst || !usable(inst.version)) continue;
                const instUser = inst.scope === "user";
                const bestUser = best && best.scope === "user";
                if (!best
                    || (instUser && !bestUser)
                    || (instUser === bestUser
                        && String(inst.lastUpdated || "") > String(best.lastUpdated || ""))) {
                    best = inst;
                }
            }
        }
        return best ? "v" + String(best.version).replace(/^v/, "") : "";
    } catch {
        return "";
    }
}

function render(j, ver = pluginVersion()) {
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
      (ver ? ` ${DIM}·${RESET} ${DIM}${PLUGIN_LABEL}${RESET} ${MAGENTA}${ver}${RESET}` : ""),
  };
}

// Tab title: account (falling back to location when no CLAUDE_CONFIG_DIR account is active),
// then model/effort. Usage percentages are deliberately NOT in the title — they change on every
// render and would make the tab flicker.
function tabTitle(r, env = process.env) {
  const head = accountLabel(env) || r.loc;
  return `${head}/${r.model}${r.effort ? "/" + r.effort : ""}`;
}

// Exported for the selftest, which asserts on render() directly rather than on a spawned process:
// a status line is a pure function of its payload, and testing it through stdio would measure the
// harness more than the renderer.
module.exports = { render, stripContextSuffix, windowSize, seg, pluginVersion, claudeDir, accountLabel, tabTitle, PLUGIN_LABEL };

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let j = {};
    try {
      j = JSON.parse(raw || "{}");
    } catch {}
    const r = render(j);

    const title = tabTitle(r);
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
