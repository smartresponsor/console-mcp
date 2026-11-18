$ErrorActionPreference='Stop'
$root=(Get-Location).Path
Write-Output ('SOURCE_HEAD='+(& git -c "safe.directory=$root" rev-parse HEAD))
Write-Output ('HELPER_SHA256='+((& sha256sum ops/ubuntu/deployment/stage08-authorize-prepare.py) -split ' ')[0])
Write-Output 'STATUS:'
& git -c "safe.directory=$root" status --short
Write-Output 'STAGE08_HELPER_HASH_PASS'
