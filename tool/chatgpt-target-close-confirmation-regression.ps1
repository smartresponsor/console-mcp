$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & node 'tool/chatgpt-target-close-confirmation-regression.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Target close confirmation regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
