param([switch]$Full, [switch]$Smoke, [switch]$Admission, [switch]$Remainder)
$ErrorActionPreference = 'Stop'
if ($Smoke) { & npm run smoke; exit $LASTEXITCODE }
if ($Full) { & npm test; exit $LASTEXITCODE }
if ($Admission) {
    & npm run admission:check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node (Join-Path $PSScriptRoot 'validate-capability-admission.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node (Join-Path $PSScriptRoot 'validate-capability-admission-diff.mjs')
    exit $LASTEXITCODE
}
if ($Remainder) {
    foreach ($test in @('cmcp-cli-regression.ps1','restart-failsafe-regression.ps1','browser-housekeeping-regression.ps1')) {
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot $test)
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & npm run test:deployment-preflight
    exit $LASTEXITCODE
}
foreach ($test in @('visible-binding-continuity-regression.mjs','visible-browser-session-regression.mjs','linux-browser-session-regression.mjs','web-domain-bridge-regression.mjs','visible-target-routing-regression.mjs','desktop-session-client-regression.mjs')) {
    & node (Join-Path $PSScriptRoot $test)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
