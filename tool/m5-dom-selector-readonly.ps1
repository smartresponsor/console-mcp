param()
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'm5-dom-selector-readonly.mjs')
if($LASTEXITCODE -ne 0){throw 'M5_DOM_DIAGNOSTIC_FAILED'}
