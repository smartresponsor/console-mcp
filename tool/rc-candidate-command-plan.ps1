$ErrorActionPreference = 'Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& node tool/rc-candidate-command-plan.mjs
if($LASTEXITCODE -ne 0){throw "Candidate plan failed: $LASTEXITCODE"}
