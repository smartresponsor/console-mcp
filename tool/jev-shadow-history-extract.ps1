[CmdletBinding()]
param(
    [int]$Limit = 500,
    [int]$SamplePerMarker = 0,
    [string]$OnlyMarker = '',
    [string]$ExcludeLedger = '',
    [switch]$Prioritize,
    [switch]$SummaryOnly,
    [switch]$IncludeText
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'jev-shadow-history-extract.mjs'
$node = Get-Command node -ErrorAction Stop

$args = @($script, '--limit', [string]$Limit)
if ($SamplePerMarker -gt 0) {
    $args += @('--sample-per-marker', [string]$SamplePerMarker)
}
if (-not [string]::IsNullOrWhiteSpace($OnlyMarker)) {
    $args += @('--only-marker', $OnlyMarker)
}
if (-not [string]::IsNullOrWhiteSpace($ExcludeLedger)) {
    $args += @('--exclude-ledger', $ExcludeLedger)
}
if ($Prioritize) {
    $args += '--prioritize'
}
if ($SummaryOnly) {
    $args += '--summary-only'
}
if ($IncludeText) {
    $args += '--include-text'
}

& $node.Source @args
exit $LASTEXITCODE
