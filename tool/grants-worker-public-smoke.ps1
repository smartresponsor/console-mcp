$ErrorActionPreference='Stop'
if(-not $IsLinux){throw 'Linux only'}
$tool=Join-Path $PSScriptRoot 'grants-worker-public-smoke.mjs'
& node -- $tool
if($LASTEXITCODE -ne 0){throw 'GRANTS_PUBLIC_DOM_SMOKE_FAILED'}
