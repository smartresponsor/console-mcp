$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & node 'tool/engine-cycle-stage-routing-regression.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Routing regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
