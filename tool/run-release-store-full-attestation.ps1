$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -I (Join-Path $root 'ops/ubuntu/deployment/release-store-full-attestation.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
