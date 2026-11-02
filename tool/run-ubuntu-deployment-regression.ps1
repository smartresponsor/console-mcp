$ErrorActionPreference='Stop'
& /usr/bin/python3 -I (Join-Path $PSScriptRoot '../ops/ubuntu/deployment/regression.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
