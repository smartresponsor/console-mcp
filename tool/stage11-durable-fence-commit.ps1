$ErrorActionPreference='Stop'
$worktree=(Get-Location).Path
$git=@('-c',"safe.directory=$worktree")
if((& git @git rev-parse HEAD).Trim() -ne 'b9b7bd87547e8935792d1b4d22cb689296d1c2e5'){throw 'BASELINE_CHANGED'}
$paths=@('ops/ubuntu/deployment/admission-lock.py','ops/ubuntu/deployment/gates.py','src/Infrastructure/Process/DeploymentAdmission.ts','tool/stage11-admission-integration-regression.mjs','tool/stage11-inflight-fence-fixture.py','tool/stage11-node-fence-crash-regression.mjs','tool/stage11-integration-tests.ps1','docs/stage11-deployment-admission-20261118.md','tool/stage11-durable-fence-commit.ps1')
& git @git add -- $paths
if($LASTEXITCODE -ne 0){throw 'GIT_STAGE_FAILED'}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){throw 'GIT_DIFF_CHECK_FAILED'}
Write-Output 'STAGED_DIFF_STAT:'
& git @git diff --cached --stat
& git @git commit -S -m 'fix(release): preserve durable admission fence across helper crash'
if($LASTEXITCODE -ne 0){throw 'GIT_COMMIT_FAILED'}
Write-Output ('STAGE11_FENCE_HEAD='+(& git @git rev-parse HEAD))
Write-Output ('SIGNATURE='+(& git @git log -1 --format='%G?' HEAD))
Write-Output 'POST_COMMIT_STATUS:'
& git @git status --short --untracked-files=normal
