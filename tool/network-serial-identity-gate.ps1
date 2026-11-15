#Requires -Version 7.0
# Exact local offline gate. No physical port opens or serial control operations.
$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_IDENTITY_BUILD_FAILED' }
& node tool/network-serial-identity-witness-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_IDENTITY_WITNESS_FAILED' }
& node tool/network-serial-admission-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_ADMISSION_FAILED' }
Write-Output 'NETWORK_SERIAL_IDENTITY_LOCAL_GATE_PASS'
