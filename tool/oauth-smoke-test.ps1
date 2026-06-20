$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$npm = Get-Command npm -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
    & $npm.Source install
}

& $npm.Source run build
& $node.Source (Join-Path $root 'tool/oauth-smoke-test.mjs')
