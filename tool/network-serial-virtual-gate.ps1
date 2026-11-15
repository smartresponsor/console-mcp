# Fixed offline acceptance for Network M2 virtual serial capture.
# No physical COM/USB ports, SSH, network targets or production processes.
$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'NETWORK_SERIAL_BUILD_FAILED' }
& node tool/network-serial-virtual-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'NETWORK_SERIAL_VIRTUAL_REGRESSION_FAILED' }
Write-Output 'NETWORK_SERIAL_LOCAL_GATE_PASS'
