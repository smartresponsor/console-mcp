$ErrorActionPreference='Stop'
& node --experimental-strip-types (Join-Path $PSScriptRoot 'background-ashby-policy-regression.mjs')
if($LASTEXITCODE -ne 0){throw 'Background Ashby policy regression failed'}
