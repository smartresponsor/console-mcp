#Requires -Version 7.0
# Read-only offline acceptance on either Ubuntu or Windows.
$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_ADMISSION_BUILD_FAILED' }
& node tool/network-serial-admission-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_ADMISSION_REGRESSION_FAILED' }
& node tool/network-pty-com-offline-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_OFFLINE_PLATFORM_REGRESSION_FAILED' }
Write-Output 'NETWORK_SERIAL_ADMISSION_LOCAL_GATE_PASS'
