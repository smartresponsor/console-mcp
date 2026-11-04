$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$test = Join-Path $root 'tool/web-worker-admission-gate-regression.mjs'
& node $test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
