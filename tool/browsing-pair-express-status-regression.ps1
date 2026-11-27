$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'browsing-pair-express-status-regression.py')
if ($LASTEXITCODE -ne 0) { throw 'BROWSING_EXPRESS_STATUS_PROTOCOL_FAILED' }
