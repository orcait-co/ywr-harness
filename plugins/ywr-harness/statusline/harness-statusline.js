// ywr-harness statusline — location · model · effort · context% · rate-limit% · installed
// plugin version, plus terminal tab-title sync.
//
// Canon of the statusline (ywr-harness ADR 0010/0016). `install.mjs` copies it to the user scope and
// overwrites the copy on every run, so fix it here and never in the installed copy. A plugin cannot
// contribute the main status line, which is why it ships with an installer (ywr-harness ADR 0016).
//
// The payload arrives as JSON on stdin. The keys used:
//   model.display_name, model.id (display fallback), effort.level
//   workspace.current_dir, workspace.project_dir (location fallback), cwd (last fallback)
//   workspace.git_worktree: the linked-worktree name, a string, present only inside a linked
//     worktree (ywr-harness ADR 0059, ywr-harness spec 0010 §3.1)
//   context_window.used_percentage, context_window.context_window_size (a session constant)
//   rate_limits.{five_hour,seven_day}.used_percentage: the account-wide windows, all the payload
//     carries. The model-scoped weekly of /usage is not in it, so no weekly renders next to the
//     model name (ywr-harness ADR 0049)
//
// A key that is absent makes its segment disappear. A segment never renders `0%` for an unmeasured
// value. Rate-limit keys are missing before the first API response of a session.
//
// The model name loses its "(1M context)" suffix because the window size is constant. The size moves
// next to the percentage (`ctx 24%/1M`), because 24% of 200k and 24% of 1M differ.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Label of the plugin-version segment: the plugin's manifest name (ywr-harness ADR 0027).
const PLUGIN_LABEL = "ywr-harness";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function pctColor(v, warn, crit) {
  return v >= crit ? RED : v >= warn ? YELLOW : GREEN;
}

function seg(label, value, warn, crit) {
  if (typeof value !== "number" || !isFinite(value)) return ""; // absent = not rendered
  const v = Math.round(value);
  return ` ${DIM}·${RESET} ${DIM}${label}${RESET} ${pctColor(v, warn, crit)}${v}%${RESET}`;
}

// Quota: comfortable / watch / close.
const pct = (label, value) => seg(label, value, 50, 80);

// Context warns later than quota: 50% is ordinary working state.
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

// "Opus 5 (1M context)" -> "Opus 5". Only a trailing parenthetical that mentions `context` goes.
// "(preview)" carries information and stays.
function stripContextSuffix(name) {
  return String(name).replace(/\s*\([^()]*\bcontext\b[^()]*\)\s*$/i, "").trim() || String(name);
}

// The user scope this session runs under: a non-empty arg, else CLAUDE_CONFIG_DIR, else ~/.claude
// (ywr-harness ADR 0046). The env value counts only when absolute, because a relative one would
// resolve against the renderer's spawn directory. A set but malformed value returns "", so the
// segment disappears. A fallback to ~/.claude would read the other account's install.
function claudeDir(dir, env = process.env) {
  if (dir) return dir;
  const raw = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (raw) return path.isAbsolute(raw) ? raw : "";
  return path.join(os.homedir(), ".claude");
}

// Tab-title head: the config-dir account (`.claude-ywrlabs` -> `claude-ywrlabs`), or "" when no
// CLAUDE_CONFIG_DIR is set. It tells two otherwise identical terminals apart (ywr-harness ADR 0046).
// It is a string transform, so unlike claudeDir() it accepts a relative value. A value that strips
// to nothing yields "", and tabTitle() falls back to the location.
function accountLabel(env = process.env) {
  const dir = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (!dir) return "";
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/^\./, "");
}

function pluginVersion(dir) {
    // The version installed for this account, read from Claude Code's install registry
    // (`<config-dir>/plugins/installed_plugins.json`). It is the on-disk value, not the running
    // session's: when disk is ahead of a live session, the mismatch signals a restart (ywr-harness ADR 0027).
    // Only the plugin name is pinned, not the `@marketplace` half, because an org may name the
    // marketplace differently. A missing file, bad JSON, no entry or an "unknown" version gives "".
    try {
        const base = claudeDir(dir);
        if (!base) return ""; // a malformed CLAUDE_CONFIG_DIR is unmeasured
        const p = path.join(base, "plugins", "installed_plugins.json");
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        // A usable version has a digit. This rejects the registry's "unknown" and corrupted shapes such as "v".
        const usable = (v) => v != null && /\d/.test(String(v));
        // Several installs can coexist. The file is placed machine-wide, so the user-scope entry wins.
        // Ties go to the latest lastUpdated, never to registry order.
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
  // Linked-worktree name (ywr-harness ADR 0059). Only a string renders. The name is member-chosen
  // and sits between this line's escape codes, so control bytes are stripped.
  const wt =
    (j.workspace && typeof j.workspace.git_worktree === "string"
      ? j.workspace.git_worktree.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "");
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
      `\x1b[36m${loc}${RESET}` +
      (wt ? ` ${DIM}·${RESET} ${DIM}wt${RESET} \x1b[36m${wt}${RESET}` : "") +
      ` ${DIM}·${RESET} \x1b[1m${model}${RESET}` +
      (effort ? ` ${DIM}·${RESET} \x1b[33m${effort}${RESET}` : "") +
      ctxSeg +
      // The size renders only after a percentage.
      (ctxSeg && size ? `${DIM}/${size}${RESET}` : "") +
      pct("5h", rl.five_hour && rl.five_hour.used_percentage) +
      // The weekly stays at the tail for every model, because it is account-wide and a model chunk
      // would read as a model-scoped figure (ywr-harness ADR 0049).
      pct("7d", rl.seven_day && rl.seven_day.used_percentage) +
      // The version is magenta, outside the green/yellow/red threshold colors.
      (ver ? ` ${DIM}·${RESET} ${DIM}${PLUGIN_LABEL}${RESET} ${MAGENTA}${ver}${RESET}` : ""),
  };
}

// Tab title: account (location when no account is active), then model and effort. It holds no usage
// percentage, because the tab would flicker on every render.
function tabTitle(r, env = process.env) {
  const head = accountLabel(env) || r.loc;
  return `${head}/${r.model}${r.effort ? "/" + r.effort : ""}`;
}

// Exported for the selftest, which asserts on render() directly.
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
      // CONOUT$ is absent on non-Windows and on redirected consoles. The title is best effort.
    }
  process.stdout.write(r.line);
  });
}
