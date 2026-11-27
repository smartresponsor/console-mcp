$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-pair-lifecycle-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_PAIR_LIFECYCLE_REGRESSION_FAILED' }
Write-Output 'BROWSING_PAIR_LIFECYCLE_REGRESSION_PASS (fixture service adapter; real filesystem publication)'
