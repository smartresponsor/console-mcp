$ErrorActionPreference = 'Stop'
$root=Split-Path -Parent $PSScriptRoot
Push-Location $root
try { & node tool/database-isolation-regression.mjs; if($LASTEXITCODE -ne 0){throw 'Database isolation regression failed'} } finally { Pop-Location }
