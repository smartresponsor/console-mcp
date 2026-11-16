param()
$ErrorActionPreference='Stop'
if(-not $env:M5_EXPECTED_TARGET_ID -or -not $env:M5_EXPECTED_CHAT_ID){throw 'M5_EXPLICIT_TARGET_CHAT_REQUIRED'}
& node (Join-Path $PSScriptRoot 'm5-native-expression-readonly.mjs')
if($LASTEXITCODE -ne 0){throw 'M5_BOUND_NATIVE_EXPRESSION_FAILED'}
