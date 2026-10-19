$ErrorActionPreference='Stop'
& node --experimental-strip-types (Join-Path $PSScriptRoot 'web-artifact-import-regression.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Web artifact import regression failed' }
