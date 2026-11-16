$ErrorActionPreference='Stop'
$root=(Get-Location).Path
Push-Location $root
try {
  & /usr/bin/python3 -I -m py_compile ops/ubuntu/deployment/gates.py ops/ubuntu/deployment/prepare.py ops/ubuntu/deployment/regression.py
  if($LASTEXITCODE -ne 0){throw 'PYTHON_COMPILE_FAILED'}
  & /usr/bin/python3 -I ops/ubuntu/deployment/regression.py
  if($LASTEXITCODE -ne 0){throw 'DEPLOYMENT_REGRESSION_FAILED'}
  Write-Output 'NET271_NATIVE_PROOF_OBSERVABILITY_PASS'
} finally {Pop-Location}
