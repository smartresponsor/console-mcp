$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& node tool/rc-actual-checkout-acceptance.mjs
if($LASTEXITCODE -ne 0){throw "Actual checkout RC admission failed: $LASTEXITCODE"}
