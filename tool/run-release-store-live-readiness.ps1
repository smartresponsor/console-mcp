$ErrorActionPreference='Stop'
$repo=Resolve-Path (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -I (Join-Path $repo 'ops/ubuntu/deployment/release-store-live-readiness.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
