$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'json-transport-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
