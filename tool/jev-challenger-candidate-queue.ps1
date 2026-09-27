[CmdletBinding()]
param(
    [int]$Limit = 24,
    [int]$SamplePerMarker = 3,
    [switch]$IncludeText
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

if ($IncludeText) {
    $args += '--include-text'
}

& $node.Source @args
exit $LASTEXITCODE
