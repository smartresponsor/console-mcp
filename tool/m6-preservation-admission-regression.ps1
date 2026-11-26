$ErrorActionPreference = 'Stop'
if (-not $IsLinux) { Write-Output 'M6_PRESERVATION_ADMISSION_LINUX_ONLY'; exit 0 }
Set-Location (Join-Path $PSScriptRoot '..')
& /usr/bin/python3 -B (Join-Path $PSScriptRoot 'm6-preservation-admission-regression.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'M6_PRESERVATION_ADMISSION_REGRESSION_PASS'
