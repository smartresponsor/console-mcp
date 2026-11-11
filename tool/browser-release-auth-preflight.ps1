$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$report = @(& node tool/browser-release-auth-preflight.mjs)
$code=$LASTEXITCODE
$report | ForEach-Object { Write-Output $_ }
if ($code -ne 0 -and $code -ne 2) { throw "Preflight unexpected failure: $code" }
if ($code -eq 2) { Write-Output 'AUTH_PREFLIGHT_EXPECTED_BLOCKED' }
