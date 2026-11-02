$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'json-transport-inbox-smoke.mjs')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
