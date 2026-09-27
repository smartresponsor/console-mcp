[CmdletBinding()]
param(
    [ValidateRange(1, 25)]
    [int]$PerCategory = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction Stop
$script = Join-Path $PSScriptRoot 'jev-challenger-candidate-report.mjs'
& $node.Source $script "--per-category=$PerCategory"
exit $LASTEXITCODE
