$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'registration-ast-inventory.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
