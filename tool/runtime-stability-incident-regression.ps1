$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('console-mcp-stability-incident-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$script:RuntimeFailureLedgerFile = Join-Path $tempRoot 'runtime-failures.ndjson'

function Register-WatchdogCadenceLane { param($Name, $IntervalSeconds, $Invoke, $IsDue, $InsertBefore) }

. (Join-Path $repoRoot 'tool\dev-console.d\99-runtime-stability.ps1')

function Write-FailureStart {
    param([datetimeoffset]$Timestamp, [string]$Class)
    [pscustomobject]@{
        schema_version = 1
        timestamp = $Timestamp.ToUniversalTime().ToString('o')
        event = 'failure_started'
        failure_class = $Class
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $script:RuntimeFailureLedgerFile -Encoding utf8
}

try {
    $now = [datetimeoffset]::UtcNow

    # Two real incidents, each emitting two correlated class failures.
    Write-FailureStart -Timestamp $now.AddMinutes(-10) -Class 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'
    Write-FailureStart -Timestamp $now.AddMinutes(-10).AddMilliseconds(200) -Class 'MCP_CODEX_ENDPOINT_UNRESPONSIVE'
    Write-FailureStart -Timestamp $now.AddMinutes(-2) -Class 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'
    Write-FailureStart -Timestamp $now.AddMinutes(-2).AddMilliseconds(150) -Class 'MCP_CODEX_ENDPOINT_UNRESPONSIVE'

    $grouped = Get-RuntimeFailureRecentSummary
    if ([int]$grouped.failures_15m -ne 4) { throw "Expected 4 raw failures, got $($grouped.failures_15m)" }
    if ([int]$grouped.incidents_15m -ne 2) { throw "Expected 2 incidents, got $($grouped.incidents_15m)" }
    if ([string]$grouped.stability -eq 'UNSTABLE' -or [string]$grouped.stability -eq 'CRITICAL') {
        throw "Two correlated incidents must not be over-counted as unstable: $($grouped.stability)"
    }

    Clear-Content -LiteralPath $script:RuntimeFailureLedgerFile
    Write-FailureStart -Timestamp $now.AddMinutes(-12) -Class 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'
    Write-FailureStart -Timestamp $now.AddMinutes(-7) -Class 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'
    Write-FailureStart -Timestamp $now.AddMinutes(-2) -Class 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'

    $distinct = Get-RuntimeFailureRecentSummary
    if ([int]$distinct.incidents_15m -ne 3) { throw "Expected 3 distinct incidents, got $($distinct.incidents_15m)" }
    if ([string]$distinct.stability -ne 'UNSTABLE') { throw "Three distinct incidents must remain unstable: $($distinct.stability)" }

    $roundTrip = Convert-RuntimeStabilityTimestampUtc -Value ([datetime]::SpecifyKind([datetime]'2026-09-27T01:00:00', [DateTimeKind]::Utc))
    if ($roundTrip.UtcDateTime.ToString('o') -notlike '2026-09-27T01:00:00*') { throw "UTC DateTime normalization drifted: $roundTrip" }

    Write-Output '{"ok":true,"status":"RUNTIME_STABILITY_INCIDENT_GROUPING_GREEN"}'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
