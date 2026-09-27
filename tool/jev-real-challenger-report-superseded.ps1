[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction Stop
$script = Join-Path $PSScriptRoot 'jev-real-challenger-report.mjs'

& $node.Source $script
exit $LASTEXITCODE
