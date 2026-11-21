$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  & python3 -m json.tool policy/allowed-check.json > $null
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 allowed-check policy JSON invalid' }
  & bash -n ops/ubuntu/script/workspace-ownership.sh
  if ($LASTEXITCODE -ne 0) { throw "ENG16 Bash syntax failed: $LASTEXITCODE" }
  & node tool/workspace-ownership-regression.mjs
  if ($LASTEXITCODE -ne 0) { throw "ENG16 regression failed: $LASTEXITCODE" }
  & python3 -B tool/ownership-preflight-regression.py
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 adversarial preflight failed' }
  & python3 -B tool/ownership-real-acl-regression.py
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 real ACL regression failed' }
  & python3 -B tool/ownership-multitarget-regression.py
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 multi-target ACL regression failed' }
  & git -c "safe.directory=$repo" status --short
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 per-command Git status failed' }
  & git -c "safe.directory=$repo" rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 per-command Git HEAD failed' }
  & git -c "safe.directory=$repo" diff --check
  if ($LASTEXITCODE -ne 0) { throw 'ENG16 per-command Git diff check failed' }
  Write-Output 'PASS ENG16 local non-mutating acceptance and per-command Git'
} finally { Pop-Location }
