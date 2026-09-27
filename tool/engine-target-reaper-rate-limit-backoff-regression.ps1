$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('console-mcp-reaper-backoff-' + [guid]::NewGuid().ToString('N'))
$script:RunDir = Join-Path $tempRoot 'run'
$script:Root = $repoRoot
New-Item -ItemType Directory -Path (Join-Path $script:RunDir 'engine') -Force | Out-Null

function Register-WatchdogCadenceLane { param($Name, $IntervalSeconds, $Invoke, $IsDue, $InsertBefore) }
function Get-NodeCommand { return [pscustomobject]@{ Source = 'node' } }
function Sanitize-Text { param($Value) return [string]$Value }

. (Join-Path $repoRoot 'tool\dev-console.d\99-engine-browser-target-reaper.ps1')

function Write-Receipt {
    param([datetime]$At, [string]$Status)
    $recovery = if ($Status) { [pscustomobject]@{ status = $Status; capture_status = $null; conversation_read = [pscustomobject]@{ status = $null } } } else { $null }
    $receipt = [pscustomobject]@{
        at = $At.ToUniversalTime().ToString('o')
        conversation_lifecycle = [pscustomobject]@{
            results = @([pscustomobject]@{ answer_recovery = $recovery })
        }
    }
    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $script:RunDir 'engine\browser-target-reaper-last.json') -Encoding utf8
}

try {
    $env:CONSOLE_MCP_ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_SECONDS = '120'
    Write-Receipt -At (Get-Date) -Status 'ENGINE_ANSWER_RECOVERY_RATE_LIMITED'
    $fresh = Get-EngineBrowserTargetReaperRateLimitDeferral
    if (-not $fresh) { throw 'Fresh rate-limit receipt must defer the reaper.' }
    if ($fresh.status -ne 'ENGINE_BROWSER_TARGET_REAPER_RATE_LIMIT_DEFERRED') { throw "Unexpected fresh deferral status: $($fresh.status)" }
    if ([int]$fresh.remaining_seconds -le 0 -or [int]$fresh.remaining_seconds -gt 120) { throw "Fresh remaining_seconds out of range: $($fresh.remaining_seconds)" }

    Write-Receipt -At ((Get-Date).AddSeconds(-130)) -Status 'ENGINE_ANSWER_RECOVERY_RATE_LIMITED'
    $expired = Get-EngineBrowserTargetReaperRateLimitDeferral
    if ($expired) { throw ('Expired rate-limit receipt must not defer the reaper. actual=' + ($expired | ConvertTo-Json -Depth 10 -Compress)) }

    Write-Receipt -At (Get-Date) -Status 'ENGINE_ANSWER_RECOVERY_NO_NEW_ASSISTANT'
    $normal = Get-EngineBrowserTargetReaperRateLimitDeferral
    if ($normal) { throw 'Non-rate-limited receipt must not defer the reaper.' }

    $env:CONSOLE_MCP_ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_SECONDS = '300'
    if ((Get-EngineBrowserTargetReaperRateLimitBackoffSeconds) -ne 300) { throw 'Configured backoff was not honored.' }

    Write-Output '{"ok":true,"status":"ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_GREEN"}'
} finally {
    Remove-Item Env:CONSOLE_MCP_ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_SECONDS -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
