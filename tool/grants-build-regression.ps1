$ErrorActionPreference='Stop'
if(-not $IsLinux){throw 'Linux only'}
$root=Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  & bash -n 'ops/ubuntu/script/install-grants-web-worker.sh'
  if($LASTEXITCODE -ne 0){throw 'INSTALLER_SYNTAX_FAILED'}
  & node --check '../looping/browsing/playwright-worker/src/worker.js'
  if($LASTEXITCODE -ne 0){throw 'WORKER_SYNTAX_FAILED'}
  & npm run build
  if($LASTEXITCODE -ne 0){throw 'CONSOLE_BUILD_FAILED'}
  & node 'tool/web-domain-bridge-regression.mjs'
  if($LASTEXITCODE -ne 0){throw 'WEB_BRIDGE_REGRESSION_FAILED'}
  & node 'tool/visible-target-routing-regression.mjs'
  if($LASTEXITCODE -ne 0){throw 'VISIBLE_ROUTING_REGRESSION_FAILED'}
  & node 'tool/visible-browser-session-regression.mjs'
  if($LASTEXITCODE -ne 0){throw 'VISIBLE_SESSION_REGRESSION_FAILED'}
  & node 'tool/grants-bridge-routing-regression.mjs'
  if($LASTEXITCODE -ne 0){throw 'GRANTS_BRIDGE_ROUTING_REGRESSION_FAILED'}
  [pscustomobject]@{ok=$true;status='GRANTS_BUILD_LEGACY_REGRESSION_PASS';noSystemdRestart=$true;browserWrites=$false}|ConvertTo-Json -Compress
}finally{Pop-Location}
