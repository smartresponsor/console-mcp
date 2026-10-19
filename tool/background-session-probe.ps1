$ErrorActionPreference='Stop'
& node --experimental-strip-types (Join-Path $PSScriptRoot 'background-session-probe.mjs')
if($LASTEXITCODE -ne 0){throw 'Background session probe failed'}
