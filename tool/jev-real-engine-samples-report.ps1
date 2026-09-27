[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction Stop
$script = Join-Path $PSScriptRoot 'jev-real-engine-samples-report.mjs'

& $node.Source $script
exit $LASTEXITCODE
