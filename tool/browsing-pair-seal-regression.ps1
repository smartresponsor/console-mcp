$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-pair-seal-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_PAIR_SEAL_REGRESSION_FAILED' }
Write-Output 'BROWSING_PAIR_SEAL_REGRESSION_PASS (fixture only)'
