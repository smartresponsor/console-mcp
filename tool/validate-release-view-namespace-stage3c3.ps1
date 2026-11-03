$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -I (Join-Path $root 'ops/ubuntu/deployment/release-view-namespace-regression.py')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& /usr/bin/python3 -I (Join-Path $root 'ops/ubuntu/deployment/release-view-namespace-test.py')
$result=$LASTEXITCODE
if($result -eq 2){Write-Output 'KERNEL_NAMESPACE_PROOF_BLOCKED_AS_EXPECTED';exit 0}
if($result -ne 0){exit $result}
