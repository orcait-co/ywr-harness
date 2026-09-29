# Self-test for the plugin's agent definitions (ADR 0100).
# Usage: pwsh plugins/ywr-harness/agents/agents.selftest.ps1
#
# Two things no other suite reads:
#   - the PINS. Every agent's model and effort is a decision (org guide, ADR 0025/0100), and a
#     frontmatter edit changes what every Agent-tool spawn costs with nothing else failing. The
#     suite enumerates agents/*.md, so an agent added without a decided pin fails here;
#   - the worker TWIN. worker-opus.md is worker.md's body under an opus · low frontmatter, so a rule
#     added to one body and not the other would make an Opus session's delegate follow different
#     instructions. The bodies must be byte-identical (raw text, line endings included); only the
#     frontmatter differs.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core

function Split-Agent([string]$Text) {
    # Frontmatter = the lines between the opening '---' and the next '---' line; body = the rest,
    # kept RAW (no line-ending fold) so the twin comparison is byte-level.
    $m = [regex]::Match($Text, '\A---\r?\n(?<fm>.*?)\r?\n---\r?\n(?<body>.*)\z', 'Singleline')
    if (-not $m.Success) { return $null }
    $fm = @{}
    foreach ($line in ($m.Groups['fm'].Value -split "\r?\n")) {
        $kv = [regex]::Match($line, '^(?<k>[A-Za-z]+):\s*(?<v>.*)$')
        if ($kv.Success) { $fm[$kv.Groups['k'].Value] = $kv.Groups['v'].Value.Trim() }
    }
    return @{ fm = $fm; body = $m.Groups['body'].Value }
}
# The ONE twin predicate — A2 and every META probe call it, so META tests the check A2 runs.
function Test-TwinBody($A, $B) {
    return ($null -ne $A -and $null -ne $B -and $A.body.Length -gt 200 -and [string]::Equals($A.body, $B.body, [StringComparison]::Ordinal))
}

# Every agent file and its decided pin. An agents/*.md missing here fails A0 — deciding its pin is
# part of adding it. worker-opus is the only opus pin in the plugin.
$pins = [ordered]@{ 'worker' = 'sonnet/high'; 'worker-opus' = 'opus/low'; 'verifier' = 'sonnet/medium'; 'mech' = 'haiku/low'; 'reviewer' = 'sonnet/medium' }

$ok = $true
$agents = @{}
$files = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.md' | ForEach-Object { $_.BaseName } | Sort-Object)
$ok = (Assert-True 'A0 every agents/*.md has a decided pin (no unlisted agent)' (-not ($files | Where-Object { -not $pins.Contains($_) })) `
        "unlisted: $(($files | Where-Object { -not $pins.Contains($_) }) -join ', ')") -and $ok
foreach ($n in $pins.Keys) {
    $path = Join-Path $PSScriptRoot "$n.md"
    $a = if (Test-Path -LiteralPath $path) { Split-Agent ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)) } else { $null }
    $ok = (Assert-True "A0 $n.md exists and parses (frontmatter + body)" ($null -ne $a)) -and $ok
    $agents[$n] = $a
}
if (-not $ok) { Write-Host 'agents selftest: FAILED' -ForegroundColor Red; exit 1 }

# A1 — the pins, as decided; and no opus pin outside worker-opus.
foreach ($n in $pins.Keys) {
    $got = "$($agents[$n].fm['model'])/$($agents[$n].fm['effort'])"
    $ok = (Assert-True "A1 $n pin is $($pins[$n])" ($got -eq $pins[$n]) "got $got") -and $ok
}

# A2 — the twin: byte-identical bodies, the same tool denial, and the name that resolves.
$ok = (Assert-True 'A2 worker-opus body is byte-identical to worker body' (Test-TwinBody $agents['worker'] $agents['worker-opus']) `
        'bodies differ (or one is empty) — edit both, or the Opus-session delegate follows other instructions') -and $ok
$ok = (Assert-True 'A2 both twins deny Agent' ($agents['worker'].fm['disallowedTools'] -eq 'Agent' -and $agents['worker-opus'].fm['disallowedTools'] -eq 'Agent') `
        "worker=$($agents['worker'].fm['disallowedTools']) worker-opus=$($agents['worker-opus'].fm['disallowedTools'])") -and $ok
$ok = (Assert-True 'A2 worker-opus name field is worker-opus' ($agents['worker-opus'].fm['name'] -eq 'worker-opus')) -and $ok

# A3 — the routing text a model reads when it picks an agent: each twin names the other, namespaced
# (a bare name does not resolve). Neither routes to general-purpose or excludes ultracode any more:
# ultracode lifts no pin (ADR 0108).
$wd = $agents['worker'].fm['description']; $od = $agents['worker-opus'].fm['description']
$ok = (Assert-True 'A3 worker description points an Opus session at ywr-harness:worker-opus' `
        ($wd -match 'Opus session' -and $wd -match 'ywr-harness:worker-opus' -and $wd -notmatch 'ultracode|general-purpose')) -and $ok
$ok = (Assert-True 'A3 worker-opus description names ywr-harness:worker and no general-purpose route' `
        ($od -match 'ywr-harness:worker\b(?!-)' -and $od -notmatch 'general-purpose' -and ($od -replace '\(ultracode or not\)', '') -notmatch 'ultracode')) -and $ok

# META — Test-TwinBody (A2's own predicate) must refuse each drift shape a one-sided edit makes:
# a word changed mid-body, a line appended, a CRLF-only difference, and an empty body on both sides.
$raw = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'worker-opus.md'), [Text.Encoding]::UTF8)
$fmEnd = $raw.IndexOf("`n---`n") + 5
$body = $raw.Substring($fmEnd)
$mid = [int]($body.Length / 2)
$probes = [ordered]@{
    'mid-body edit' = $raw.Substring(0, $fmEnd) + $body.Substring(0, $mid) + 'X' + $body.Substring($mid + 1)
    'appended line' = $raw + "- An extra rule on one side only.`n"
    'CRLF-only'     = $raw.Substring(0, $fmEnd) + ($body -replace "`n", "`r`n")
}
foreach ($k in $probes.Keys) {
    if (Test-TwinBody $agents['worker'] (Split-Agent $probes[$k])) { Write-Host "FAIL [META]: a $k drift compared equal" -ForegroundColor Red; $ok = $false }
    else { Write-Host "PASS [META]: a $k drift is refused" -ForegroundColor Green }
}
$empty = Split-Agent "---`nname: x`n---`n"
if (Test-TwinBody $empty $empty) { Write-Host 'FAIL [META]: two empty bodies compared equal' -ForegroundColor Red; $ok = $false }
else { Write-Host 'PASS [META]: two empty bodies are refused' -ForegroundColor Green }

if (-not $ok) { Write-Host 'agents selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'agents selftest: all cases green' -ForegroundColor Green
exit 0
