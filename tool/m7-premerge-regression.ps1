$ErrorActionPreference = 'Stop'
if (-not $IsLinux) { Write-Output 'M7_PREMERGE_LINUX_ONLY'; exit 0 }
Set-Location (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot '../ops/ubuntu/deployment/release-broker-regression.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'm7-premerge-regression.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& /usr/bin/systemctl --version
foreach ($name in @('systemd-nspawn','bwrap','unshare','podman','docker')) { $cmd=Get-Command $name -ErrorAction SilentlyContinue; if ($cmd) { Write-Output "ISOLATION_BACKEND_AVAILABLE=$name" } }
Write-Output 'M7_PREMERGE_REGRESSION_PASS'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'm7-owner-finalize.py') --review
exit $LASTEXITCODE
