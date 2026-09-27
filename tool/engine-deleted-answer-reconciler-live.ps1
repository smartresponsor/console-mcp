$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $root 'dist\cli\engine-deleted-answer-reconciler-cli.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "Missing built reconciler CLI: $cli" }
$output = & $node --enable-source-maps $cli "--root=$root" '--max-work=20'
if ($LASTEXITCODE -ne 0) { throw "Reconciler CLI failed with exit code $LASTEXITCODE" }
$result = $output | ConvertFrom-Json -Depth 40
$result | ConvertTo-Json -Depth 40
