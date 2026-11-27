$ErrorActionPreference = 'Stop'
foreach ($script in @('ops/ubuntu/script/watchdog.sh','ops/ubuntu/script/runtime-maintenance.sh','ops/ubuntu/script/engine-cli.sh','tool/chat-prompt-screenshot-paired-checkpoint.sh')) {
    & bash -n $script
    if ($LASTEXITCODE -ne 0) { throw "SCRIPT_SYNTAX_FAILED $script" }
}
& node tool/ubuntu-observer-safety-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'OBSERVER_SAFETY_FAILED' }
& pwsh -NoProfile -File tool/chat-prompt-screenshot-worker-delegation-regression.ps1
if ($LASTEXITCODE -ne 0) { throw 'WORKER_DELEGATION_FAILED' }
& pwsh -NoProfile -File tool/chat-prompt-screenshot-consolidated-regression.ps1
if ($LASTEXITCODE -ne 0) { throw 'SCREENSHOT_REGRESSION_FAILED' }
Write-Output 'SCREENSHOT_FINAL_INTEGRATION_REGRESSION_PASS (candidate only)'
