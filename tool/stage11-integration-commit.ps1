$ErrorActionPreference='Stop'
$path=(Get-Location).Path
$g=@('-c',"safe.directory=$path")
if((& git @g rev-parse HEAD).Trim() -ne '4f142b4c3aba3246bbf4e0e2516972783b1a712b'){throw 'UNEXPECTED_BASELINE'}
$files=@('ops/ubuntu/deployment/admission-lock.py','ops/ubuntu/deployment/gates.py','ops/ubuntu/deployment/prepare.py','src/Infrastructure/Process/AsyncCommandRun.ts','src/Infrastructure/Process/ProcessRuntime.ts','src/Infrastructure/Process/DeploymentAdmission.ts','src/engine/engine-core.ts','src/tool/powershell-script.ts','docs/stage11-deployment-admission-20261118.md','tool/stage11-admission-integration-regression.mjs','tool/stage11-dependencies.ps1','tool/stage11-full-test-local-safe-directory.ps1','tool/stage11-integration-build.ps1','tool/stage11-integration-tests.ps1','tool/stage11-readonly-git-review.ps1','tool/stage11-integration-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){throw 'GIT_STAGE_FAILED'}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){throw 'GIT_DIFF_CHECK_FAILED'}
Write-Output 'STAGED_DIFF_STAT:'
& git @g diff --cached --stat
& git @g commit -S -m 'ops(release): integrate staged deployment admission for async and engine'
if($LASTEXITCODE -ne 0){throw 'GIT_COMMIT_FAILED'}
Write-Output ('STAGE11_INTEGRATION_HEAD='+(& git @g rev-parse HEAD))
Write-Output ('STAGE11_INTEGRATION_SIGNATURE='+(& git @g log -1 --format='%G?' HEAD))
Write-Output 'POST_COMMIT_STATUS:'
& git @g status --short --untracked-files=normal
