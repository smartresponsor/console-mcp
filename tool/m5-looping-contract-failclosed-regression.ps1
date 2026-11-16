param()
$ErrorActionPreference='Stop'
Remove-Item Env:LOOPING_VISIBLE_WORKER_SOURCE -ErrorAction SilentlyContinue
& node tool/looping-visible-browser-contract-integration.mjs
if($LASTEXITCODE -ne 2){throw ('EXPECTED_MISSING_CONTRACT_EXIT_2_ACTUAL_'+$LASTEXITCODE)}
Write-Output 'LOOPING_CONTRACT_MISSING_SOURCE_FAIL_CLOSED_PASS'
