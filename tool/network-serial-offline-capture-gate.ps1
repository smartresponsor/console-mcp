#Requires -Version 7.0
# Hardware-free serial fixture gate, no COM/TTY acquisition.
$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_CAPTURE_BUILD_FAILED' }
& node tool/network-serial-offline-capture-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_CAPTURE_REGRESSION_FAILED' }
& node tool/network-serial-session-lease-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'SERIAL_LEASE_REGRESSION_FAILED' }
Write-Output 'NETWORK_SERIAL_OFFLINE_CAPTURE_GATE_PASS'
