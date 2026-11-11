$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& /usr/bin/python3 -I ops/ubuntu/deployment/root-authenticated-smoke-regression.py
if($LASTEXITCODE -ne 0){throw "Root authenticated smoke fixture failed: $LASTEXITCODE"}
