$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-pair-runtime-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_PAIR_RUNTIME_REGRESSION_FAILED' }
Write-Output 'BROWSING_PAIR_RUNTIME_REGRESSION_PASS (fixture only)'
