$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& node tool/rc-validation-profile-live-regression.mjs
if($LASTEXITCODE -ne 0){throw "RC live profile fixture regression failed: $LASTEXITCODE"}
