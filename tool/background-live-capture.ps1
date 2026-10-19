$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'background-live-capture.mjs')
if ($LASTEXITCODE -ne 0) { throw 'background acceptance failed' }
