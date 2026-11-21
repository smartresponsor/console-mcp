param()
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tests = @(
  (Join-Path $root 'ops/ubuntu/deployment/release-policy-cas-regression.py'),
  (Join-Path $root 'ops/ubuntu/deployment/release-policy-snapshot-regression.py')
)
foreach ($test in $tests) {
  & /usr/bin/python3 -I $test
  if ($LASTEXITCODE -ne 0) { throw "Python regression failed: $test ($LASTEXITCODE)" }
}
Write-Output 'RELEASE_POLICY_CAS_AND_SNAPSHOT_REGRESSION_PASS'
