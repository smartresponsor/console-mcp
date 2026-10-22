$ErrorActionPreference='Stop'
if(-not $IsLinux){throw 'Linux only'}
$root=Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  & npm run typecheck
  if($LASTEXITCODE -ne 0){throw 'GRANTS_TYPESCRIPT_TYPECHECK_FAILED'}
  & npm run build
  if($LASTEXITCODE -ne 0){throw 'GRANTS_TYPESCRIPT_BUILD_FAILED'}
  & node --check '../looping/browsing/playwright-worker/src/worker.js'
  if($LASTEXITCODE -ne 0){throw 'GRANTS_BROWSING_WORKER_SYNTAX_FAILED'}
  & systemd-analyze verify 'ops/ubuntu/systemd/console-mcp-grants-web-worker.service'
  if($LASTEXITCODE -ne 0){throw 'GRANTS_WORKER_UNIT_VERIFY_FAILED'}
  & node 'tool/grants-routing-preflight.mjs' --sandbox
  if($LASTEXITCODE -ne 0){throw 'GRANTS_SESSION_PROOF_FAILED'}
} finally {Pop-Location}
