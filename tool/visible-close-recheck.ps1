$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'visible-close-recheck.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Lifecycle recheck failed' }
