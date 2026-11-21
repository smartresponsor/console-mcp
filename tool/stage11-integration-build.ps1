$ErrorActionPreference='Stop'
& npm run build
if($LASTEXITCODE -ne 0){throw 'STAGE11_BUILD_FAIL'}
Write-Output 'STAGE11_BUILD_PASS'
