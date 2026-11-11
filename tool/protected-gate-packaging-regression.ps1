$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& /usr/bin/python3 -I ops/ubuntu/deployment/protected-gate-packaging-regression.py
if($LASTEXITCODE -ne 0){throw 'Protected root gates packaging regression failed'}
