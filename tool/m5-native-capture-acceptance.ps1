param()
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'm5-native-empty-capture-regression.mjs')
if($LASTEXITCODE -ne 0){throw 'M5_NATIVE_CAPTURE_REGRESSION_FAILED'}
& node (Join-Path $PSScriptRoot 'm5-static-effort-status-regression.mjs')
if($LASTEXITCODE -ne 0){throw 'M5_STATIC_EFFORT_REGRESSION_FAILED'}
