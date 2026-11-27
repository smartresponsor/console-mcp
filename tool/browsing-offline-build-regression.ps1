$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-offline-build-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_OFFLINE_BUILD_REGRESSION_FAILED' }
Write-Output 'BROWSING_OFFLINE_BUILD_REGRESSION_PASS (fixture only)'
