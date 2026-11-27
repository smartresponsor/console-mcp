$ErrorActionPreference = 'Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-pair-admission-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_PAIR_ADMISSION_REGRESSION_FAILED' }
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot '../ops/ubuntu/deployment/release-broker-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'RELEASE_BROKER_COMPATIBILITY_FAILED' }
Write-Output 'BROWSING_PAIR_ADMISSION_REGRESSION_PASS (fixture only)'
