param([switch]$ApproveHarmlessPage)
$ErrorActionPreference = 'Stop'
if (-not $ApproveHarmlessPage) { throw 'Explicit harmless-page authorization required' }
& node (Join-Path $PSScriptRoot 'windows-native-parity-live.mjs') --approved-harmless-page
exit $LASTEXITCODE
