$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
& node tool/browser-facade-http-regression.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
