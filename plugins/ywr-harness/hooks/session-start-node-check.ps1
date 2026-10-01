# SessionStart (matcher `startup|resume|fork`) — "node is not on PATH" notice, SUGGEST-ONLY.
#
# Every other hook of the plugin (eight) runs on Node, registered in exec form (`command: node`):
# at session start, on a config change, on an added directory, on every Agent call and on every
# subagent stop. With no `node` on PATH the host cannot start them and shows a hook error at each of
# those events — an error that reads like a defect in the member's own repo. Nothing else says what
# the cause is, so this hook does, once per session start: it names the missing runtime, the events
# whose hooks fail because of it, and how to fix it. It is PowerShell on purpose — it detects the
# absence of node, so it cannot itself run on node.
#
# Detection mirrors how the host launches an exec-form `node` (the command must resolve to a real
# executable on PATH): every entry of $env:PATH (split on the platform's path separator, empty
# entries skipped, surrounding quotes stripped) is probed. On Windows a hit is an existing
# `node.exe` ONLY — a `node.cmd` / `node.bat` / `node.ps1` shim (what some version managers and
# installers leave) cannot be launched by an exec-form hook, so a shim with no node.exe still
# counts as absent, and the banner names the shim it found. Elsewhere a hit is an existing regular
# `node` file with an execute bit (user, group or other); a `node` without one counts as absent and is
# named too. The banner also covers "installed but not visible" (nvm, or Claude Code launched from a
# GUI/Dock that never inherited the shell's PATH). The probes are .NET calls (`[IO.File]::Exists`, `[IO.Path]::Combine`), and the stdin read
# and the output use .NET too: no cmdlet is called, so the first-cmdlet module auto-load that costs
# a pwsh hook ~300 ms is never paid — and `Get-Command` on an ABSENT command costs ~1.5 s
# (module auto-discovery over every PATH entry). The exact files probed are the whole check: a
# node.exe that exists but cannot run is the host's error to show, not this notice's.
#
# Output contract (hooks doc): found -> byte-silent (plain stdout on exit 0 would become session
# context). Missing -> one JSON line: `systemMessage` for the member (Korean, reader-keyed) and
# `hookSpecificOutput.additionalContext` (English, SessionStart) so the model can tell the hook
# errors it will see are this and not a bug in the repo. Nothing is blocked or changed; exit 0
# always. Fail-open: unparseable stdin or another event is a silent exit 0. The matcher skips
# `clear` and `compact`: they run in the same process, whose PATH has not changed.
#
# The shim path renders through Inline() and a length cap (C0, DEL, NEL, U+2028/U+2029, backtick —
# the hook-lib.mjs inline() class), so a crafted PATH entry cannot forge a banner line. The prose
# cites no decision numbers: a member cannot follow a canon ADR from their own repo (spec 0006 §3.1).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Inline([string]$Text, [int]$Max = 80) {
    $t = (([string]$Text) -replace '[\u0000-\u001F\u007F\u0085\u2028\u2029`]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max - 1) + '…' }
    return $t
}

# The event name, read without a cmdlet: key lookup and value compare are case-insensitive like the
# other pwsh hooks' member access and `-ne`. $null on anything unparseable or not an object.
function Get-EventName([string]$Json) {
    try {
        $doc = [System.Text.Json.JsonDocument]::Parse($Json.TrimStart([char]0xFEFF))
        try {
            if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $null }
            foreach ($p in $doc.RootElement.EnumerateObject()) {
                if ($p.Name -eq 'hook_event_name' -and $p.Value.ValueKind -eq [System.Text.Json.JsonValueKind]::String) { return $p.Value.GetString() }
            }
            return $null
        }
        finally { $doc.Dispose() }
    }
    catch { return $null }
}

try { $evName = Get-EventName ([Console]::In.ReadToEnd()) } catch { exit 0 }
if ($evName -ne 'SessionStart') { exit 0 }

$isWin = [IO.Path]::DirectorySeparatorChar -eq '\'
$nodeFile = if ($isWin) { 'node.exe' } else { 'node' }
$shimNames = if ($isWin) { @('node.cmd', 'node.bat', 'node.ps1') } else { @() }
$near = ''; $nearKind = ''   # the first near-miss on PATH: a Windows shim, or a non-executable `node`
foreach ($entry in ([string][Environment]::GetEnvironmentVariable('PATH')).Split([IO.Path]::PathSeparator)) {
    $dir = $entry.Trim().Trim('"')
    if (-not $dir) { continue }
    try {
        $cand = [IO.Path]::Combine($dir, $nodeFile)
        if ([IO.File]::Exists($cand)) {
            if ($isWin) { exit 0 }
            # Homebrew and nvm install node as a SYMLINK, and the host's exec follows it. Measured on .NET 10
            # (Linux): File.Exists is $true for a DANGLING link too, while GetUnixFileMode uses stat — it
            # follows the link and throws for a dangling one. So the mode of the TARGET decides, and a throw
            # means a dangling link: absent, and not named as "not executable".
            $mode = -1
            try { $mode = [int][IO.File]::GetUnixFileMode($cand) } catch { }
            # 73 = UserExecute (64) + GroupExecute (8) + OtherExecute (1)
            if ($mode -ge 0) {
                if ($mode -band 73) { exit 0 }
                if (-not $near) { $near = $cand; $nearKind = 'noexec' }
            }
        }
        if (-not $near) {
            foreach ($n in $shimNames) { if ([IO.File]::Exists([IO.Path]::Combine($dir, $n))) { $near = [IO.Path]::Combine($dir, $n); $nearKind = 'shim'; break } }
        }
    }
    catch { continue }   # an entry that is not a valid path (illegal characters) cannot hold node
}

$sys = '[hook:node-check] PATH 에서 `node` 를 찾지 못해, Node 로 도는 ywr-harness 의 다른 훅 8개가 ' +
       '세션 시작·설정 변경·디렉터리 추가·Agent 호출·서브에이전트 종료 때마다 훅 오류를 표시합니다(아무것도 차단되지는 않습니다). '
if ($near) {
    $nearShown = Inline $near 300
    $sys += if ($nearKind -eq 'shim') { "PATH 에서 ${nearShown} 는 찾았지만, exec 형식 훅은 실제 node.exe 만 실행할 수 있습니다(.cmd·.bat·.ps1 shim 은 안 됩니다). " }
            else { "PATH 에서 ${nearShown} 는 찾았지만 실행 권한이 없습니다(chmod +x 가 필요합니다). " }
}
$sys += 'Node.js LTS 를 설치하고(Windows: `winget install OpenJS.NodeJS.LTS`, macOS: `brew install node`, Linux: 배포판 패키지 또는 nodejs.org) ' +
        'Claude Code 를 다시 시작하면 이 안내와 오류가 사라집니다. ' +
        '이미 설치돼 있다면(nvm 등, 또는 GUI·Dock 에서 실행해 셸의 PATH 를 물려받지 못한 경우) `node` 가 잡히는 터미널에서 Claude Code 를 시작하거나, node 폴더를 Claude Code 가 물려받는 PATH 에 넣으세요.'
$ctx = 'Node.js is not on PATH, so the eight ywr-harness hooks that run on Node cannot start and will report a hook error at session start, ' +
       'on a config change, on an added directory, on every Agent call and on every subagent stop. Those errors come from the missing runtime, ' +
       "not from a defect in the user's repository, and nothing was blocked. " +
       $(if ($nearKind -eq 'shim') { 'A node shim was found on PATH, but an exec-form hook needs a real node executable. ' }
         elseif ($nearKind -eq 'noexec') { 'A node file was found on PATH, but it is not executable. ' } else { '' }) +
       'Installing Node.js LTS and restarting Claude Code clears them; if Node is already installed (nvm, or Claude Code launched from a GUI/Dock without the shell PATH), start Claude Code from a terminal where `node` resolves, or put its directory on the PATH Claude Code inherits.'

$hso = [System.Collections.Generic.Dictionary[string, object]]::new()
$hso['hookEventName'] = 'SessionStart'
$hso['additionalContext'] = $ctx
$out = [System.Collections.Generic.Dictionary[string, object]]::new()
$out['systemMessage'] = $sys
$out['hookSpecificOutput'] = $hso
[Console]::Out.WriteLine([System.Text.Json.JsonSerializer]::Serialize($out, $out.GetType()))
exit 0
