$ErrorActionPreference='Stop'
$cache=Join-Path (Get-Location).Path '.stage11-npm-cache'
Write-Output ('STAGE11_NPM_CACHE='+$cache)
& npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --cache $cache
if($LASTEXITCODE -ne 0){throw 'OFFLINE_DEPENDENCIES_UNAVAILABLE'}
Write-Output 'STAGE11_ISOLATED_NPM_CI_PASS'
