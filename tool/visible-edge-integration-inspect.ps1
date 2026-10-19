param([switch]$RunRegressionChecks, [string]$TargetId = '')
# Use the authorized Console script runner so credentials stay in the service environment.
$ErrorActionPreference = 'Stop'
if ($RunRegressionChecks) {
  foreach ($check in @('visible-browser-session-regression.mjs', 'linux-browser-session-regression.mjs', 'web-domain-bridge-regression.mjs', 'ubuntu-observer-safety-regression.mjs')) {
    & node (Join-Path $PSScriptRoot $check)
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $check ($LASTEXITCODE)" }
  }
  exit 0
}
& node (Join-Path $PSScriptRoot 'visible-edge-integration-inspect.mjs') $TargetId
if ($LASTEXITCODE -ne 0) { throw "Visible Edge inspection failed: $LASTEXITCODE" }
