$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try { & node tool/console-tool-admission-projection-cli.mjs --write; if ($LASTEXITCODE -ne 0) { throw 'Admission projection failed' } } finally { Pop-Location }
