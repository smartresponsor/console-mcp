param([string]$Candidate)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($Candidate) {
    $candidateRoot = (Resolve-Path -LiteralPath $Candidate).Path
    if (-not $candidateRoot.StartsWith("$root/tmp/visible-runtime-")) { throw 'Candidate outside deployment staging' }
    & node "$root/node_modules/typescript/bin/tsc" -p "$candidateRoot/tsconfig.json" --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Candidate typecheck failed' }
    & node "$root/node_modules/typescript/bin/tsc" -p "$candidateRoot/tsconfig.json"
    if ($LASTEXITCODE -ne 0) { throw 'Candidate build failed' }
}
$testRoot = if ($Candidate) { $candidateRoot } else { $root }
foreach ($test in @('visible-browser-session-regression.mjs','linux-browser-session-regression.mjs','web-domain-bridge-regression.mjs','ubuntu-observer-safety-regression.mjs')) {
    & node "$testRoot/tool/$test"
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $test" }
}

foreach ($test in @('desktop-session-agent-contract-test.ps1','desktop-session-agent-validation.ps1')) {
    & pwsh -NoProfile -File "$root/tool/$test"
    if ($LASTEXITCODE -ne 0) { throw "Agent regression failed: $test" }
}
& node "$root/tool/desktop-session-client-regression.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Desktop client regression failed' }
