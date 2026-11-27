$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run test:chat-prompt-screenshot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    foreach ($test in @('visible-browser-session-regression.mjs','visible-binding-continuity-regression.mjs','visible-target-routing-regression.mjs','f30-looping-socket-regression.mjs')) {
        & node (Join-Path $root "tool/$test")
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally { Pop-Location }
