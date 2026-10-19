$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'gc-ai-fields-inspect.mjs')
if ($LASTEXITCODE -ne 0) { throw 'GC AI inspection failed' }
