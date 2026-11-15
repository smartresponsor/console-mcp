$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
& node (Join-Path $PSScriptRoot "f30-looping-socket-regression.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node "tool/mcp-facade-http-regression.mjs" looping
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node "tool/network-tunnel-unix-regression.mjs"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "F30_ALL_ACCEPTANCE_PASS"
