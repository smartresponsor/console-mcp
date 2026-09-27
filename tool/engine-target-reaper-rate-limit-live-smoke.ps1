$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$script:Root = $repoRoot
$script:RunDir = Join-Path $repoRoot 'var\run'

function Register-WatchdogCadenceLane { param($Name, $IntervalSeconds, $Invoke, $IsDue, $InsertBefore) }
function Get-NodeCommand { return [pscustomobject]@{ Source = 'node' } }
function Sanitize-Text { param($Value) return [string]$Value }

. (Join-Path $repoRoot 'tool\dev-console.d\99-engine-browser-target-reaper.ps1')

$deferral = Get-EngineBrowserTargetReaperRateLimitDeferral
[pscustomobject]@{
    ok = $true
    status = if ($deferral) { 'ENGINE_TARGET_REAPER_LIVE_BACKOFF_ACTIVE' } else { 'ENGINE_TARGET_REAPER_LIVE_BACKOFF_INACTIVE' }
    deferral = $deferral
} | ConvertTo-Json -Depth 10
