$ErrorActionPreference='Stop'
$pwdPath=(Get-Location).Path
$git=@('-c',"safe.directory=$pwdPath")
if((& git @git rev-parse HEAD).Trim() -ne 'f98d5080a95679b45def3d030d49f33944c67d59'){throw 'STAGE11_BASELINE_MISMATCH'}
$files=@('ops/ubuntu/deployment/admission-lock.py','ops/ubuntu/deployment/gates.py','src/Infrastructure/Patch/UnifiedDiffPatch.ts','src/Infrastructure/Process/DeploymentAdmission.ts','src/tool/local-php-server.ts','src/tool/mobile-edge-server.ts','src/tool/network-ssh-scrapli.ts','src/tool/qa.ts','src/tool/visual-gallery-server.ts','tool/stage11-node-fence-crash-regression.mjs','tool/stage11-queue-failclosed-fixture.py','tool/stage11-admission-lock-fixture.py','tool/stage11-admin-boundary-readonly.ps1','docs/stage11-deployment-admission-20261118.md','docs/stage11-privileged-staging-runbook-20261119.md','tool/stage11-direct-producers-security-commit.ps1')
& git @git add -- $files
if($LASTEXITCODE -ne 0){throw 'GIT_ADD_FAILED'}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){throw 'GIT_DIFF_CHECK_FAILED'}
& git @git diff --cached --stat
& git @git commit -S -m 'fix(release): cover direct producer paths and pin service-owned fence identity'
if($LASTEXITCODE -ne 0){throw 'GIT_COMMIT_FAILED'}
Write-Output ('STAGE11_FINAL_HEAD='+(& git @git rev-parse HEAD))
Write-Output ('SIGNATURE_STATUS='+(& git @git log -1 --format='%G?' HEAD))
Write-Output 'POST_COMMIT_STATUS:'
& git @git status --short --untracked-files=normal
