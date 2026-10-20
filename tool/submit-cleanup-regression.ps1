$ErrorActionPreference='Stop'
$repo=Join-Path (Split-Path -Parent $PSScriptRoot) '../looping/browsing'
Push-Location $repo
try {
  & node --check 'playwright-worker/src/worker.js'
  if($LASTEXITCODE -ne 0){throw 'Worker JS syntax failed'}
  & node 'tool/web-status-taxonomy-regression.mjs'
  if($LASTEXITCODE -ne 0){throw 'Submit status taxonomy regression failed'}
  & git grep -n 'ENABLE_SUBMIT\|SUBMIT_DISABLED' -- ':!node_modules'
  if($LASTEXITCODE -eq 0){throw 'Legacy submit-disable reference remains in tracked files'}
  if($LASTEXITCODE -ne 1){throw 'Git grep failed'}
  Write-Output 'SUBMIT_LEGACY_REMOVAL_GREEN'
} finally { Pop-Location }
