#Requires -Version 7.0
# Offline lease acceptance only. No physical COM/TTY access.
$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_LEASE_BUILD_FAILED' }
& node tool/network-serial-session-lease-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_LEASE_REGRESSION_FAILED' }
& node tool/network-serial-identity-witness-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_IDENTITY_REGRESSION_FAILED' }
Write-Output 'NETWORK_SERIAL_LEASE_LOCAL_GATE_PASS'
