$ErrorActionPreference='Stop'
$wd=(Get-Location).Path
$git=@('-c',"safe.directory=$wd")
if((& git @git rev-parse HEAD).Trim() -ne 'd95cc6817ea3eea75103a62ff421bdd7c90fe399'){throw 'STAGE11_BASELINE_CHANGED'}
$paths=@('ops/ubuntu/deployment/gates.py','src/Infrastructure/Process/SupervisedCommand.ts','tool/stage11-queue-failclosed-fixture.py','tool/stage11-admission-integration-regression.mjs','tool/stage11-integration-tests.ps1','docs/stage11-deployment-admission-20261118.md','tool/stage11-queue-and-subprocess-commit.ps1')
& git @git add -- $paths
if($LASTEXITCODE -ne 0){throw 'STAGE11_ADD_FAILED'}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){throw 'STAGE11_DIFF_CHECK_FAILED'}
Write-Output 'STAGE11_STAGED_DIFF:'
& git @git diff --cached --stat
& git @git commit -S -m 'fix(release): fail closed on queue corruption and guard supervised subprocesses'
if($LASTEXITCODE -ne 0){throw 'STAGE11_COMMIT_FAILED'}
Write-Output ('STAGE11_HEAD='+(& git @git rev-parse HEAD))
Write-Output ('SIGNATURE='+(& git @git log -1 --format='%G?' HEAD))
& git @git status --short --untracked-files=normal
