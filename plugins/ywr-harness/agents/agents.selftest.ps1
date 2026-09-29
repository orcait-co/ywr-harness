# Self-test for the plugin's agent definitions (ADR 0100, ADR 0109).
# Usage: pwsh plugins/ywr-harness/agents/agents.selftest.ps1
#
# One thing no other suite reads: the PINS. Every agent's model and effort is a decision (org guide,
# ADR 0025/0109), and a frontmatter edit changes what every Agent-tool spawn costs with nothing else
# failing. The suite enumerates agents/*.md, so an agent added without a decided pin fails here.
# ADR 0109 retired the Opus-session twin `worker-opus`: `worker` (sonnet · high) is the delegate on
# every session model, measured faster at equal quality, so no agent pins opus.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/selftest-lib.ps1')   # assertion core

function Split-Agent([string]$Text) {
    # Frontmatter = the lines between the opening '---' and the next '---' line; body = the rest.
    $m = [regex]::Match($Text, '\A---\r?\n(?<fm>.*?)\r?\n---\r?\n(?<body>.*)\z', 'Singleline')
    if (-not $m.Success) { return $null }
    $fm = @{}
    foreach ($line in ($m.Groups['fm'].Value -split "\r?\n")) {
        $kv = [regex]::Match($line, '^(?<k>[A-Za-z]+):\s*(?<v>.*)$')
        if ($kv.Success) { $fm[$kv.Groups['k'].Value] = $kv.Groups['v'].Value.Trim() }
    }
    return @{ fm = $fm; body = $m.Groups['body'].Value }
}

# Every agent file and its decided pin. An agents/*.md missing here fails A0 — deciding its pin is
# part of adding it.
$pins = [ordered]@{ 'worker' = 'sonnet/high'; 'verifier' = 'sonnet/medium'; 'mech' = 'haiku/low'; 'reviewer' = 'sonnet/medium' }

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

# A1 — the pins, as decided; and no agent pins opus or fable (ADR 0109: the measured delegate on an
# Opus session is the sonnet worker; an opus pin would move every spawn of that type off it).
foreach ($n in $pins.Keys) {
    $got = "$($agents[$n].fm['model'])/$($agents[$n].fm['effort'])"
    $ok = (Assert-True "A1 $n pin is $($pins[$n])" ($got -eq $pins[$n]) "got $got") -and $ok
}
# The decided table itself names no opus/fable pin, so adding one to both the table and a file is
# still caught here, not only a file that drifts from the table.
foreach ($n in $pins.Keys) {
    $ok = (Assert-True "A1 decided pin for $n names no opus/fable model" ($pins[$n] -notmatch '(?i)opus|fable') "pin: $($pins[$n])") -and $ok
}

# A2 — worker is the one delegate: it denies Agent (fan-out belongs to the orchestrator), and the
# retired twin stays retired — no worker-opus file, and no description routes to it.
$ok = (Assert-True 'A2 worker denies Agent' ($agents['worker'].fm['disallowedTools'] -eq 'Agent') `
        "disallowedTools: $($agents['worker'].fm['disallowedTools'])") -and $ok
$ok = (Assert-True 'A2 worker-opus.md is retired (ADR 0109)' (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'worker-opus.md')))) -and $ok
foreach ($n in $pins.Keys) {
    $ok = (Assert-True "A2 $n description names no worker-opus route" ($agents[$n].fm['description'] -notmatch 'worker-opus')) -and $ok
}

# A3 — the routing text a model reads when it picks an agent: worker says it serves every session
# model, Opus included, and routes neither to general-purpose nor around ultracode (ADR 0108).
$wd = $agents['worker'].fm['description']
$ok = (Assert-True 'A3 worker description says it serves every session model, Opus included' `
        ($wd -match 'every session model' -and $wd -match 'Opus included' -and $wd -notmatch 'ultracode|general-purpose')) -and $ok

if (-not $ok) { Write-Host 'agents selftest: FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'agents selftest: all cases green' -ForegroundColor Green
exit 0
