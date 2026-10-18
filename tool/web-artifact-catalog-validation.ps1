$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'validate-console-tool-catalog.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Console catalog validation failed' }
