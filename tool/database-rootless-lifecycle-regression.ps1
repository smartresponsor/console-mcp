$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Push-Location $root
try { & node tool/database-rootless-lifecycle-regression.mjs; if($LASTEXITCODE -ne 0){throw 'Rootless lifecycle regression failed'} } finally { Pop-Location }
