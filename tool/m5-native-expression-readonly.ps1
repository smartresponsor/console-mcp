param()
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'm5-native-expression-readonly.mjs')
if($LASTEXITCODE -ne 0){throw 'M5_NATIVE_EXPRESSION_READONLY_FAILED'}
