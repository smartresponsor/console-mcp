[CmdletBinding()]
param(
    [int]$Limit = 24,
    [int]$SamplePerMarker = 3,
    [switch]$IncludeText,
    [string]$EventLog = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$extractor = Join-Path $PSScriptRoot 'jev-shadow-history-extract.mjs'
$ledger = Join-Path $PSScriptRoot 'fixture\jev-challenger-adjudicated.json'
$node = Get-Command node -ErrorAction Stop

$args = @(
    $extractor,
    '--limit', [string]$Limit,
    '--sample-per-marker', [string]$SamplePerMarker,
    '--exclude-ledger', $ledger,
    '--prioritize'
)

if (-not [string]::IsNullOrWhiteSpace($EventLog)) {
    $resolvedEventLog = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($EventLog)
    if (-not (Test-Path -LiteralPath $resolvedEventLog -PathType Leaf)) {
        throw "JEV_CHALLENGER_EVENT_LOG_MISSING: supplied event log does not exist: $resolvedEventLog"
    }
    $args += @("--event-log", $resolvedEventLog)
}

if ($IncludeText) {
    $args += '--include-text'
}

& $node.Source @args
exit $LASTEXITCODE
