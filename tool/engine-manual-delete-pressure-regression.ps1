$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
    & node tool/engine-manual-delete-pressure-regression.mjs
    if ($LASTEXITCODE -ne 0) { throw "Regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
