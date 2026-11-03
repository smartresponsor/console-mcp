$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -I (Join-Path $root 'ops/ubuntu/deployment/regression.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& /usr/bin/python3 -I (Join-Path $root 'ops/ubuntu/deployment/release-view-mount-regression.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
