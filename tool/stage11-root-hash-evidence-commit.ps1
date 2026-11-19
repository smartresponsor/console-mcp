$ErrorActionPreference='Stop'
$wd=(Get-Location).Path
$g=@('-c',"safe.directory=$wd")
if((& git @g rev-parse HEAD).Trim() -ne '4b09c82b91a202d20834e6559e2526551fbf7182'){throw 'BASELINE_CHANGED'}
$files=@('tool/stage11-admin-boundary-readonly.ps1','docs/stage11-privileged-staging-runbook-20261119.md','tool/stage11-root-hash-evidence-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){throw 'GIT_STAGE_FAILED'}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){throw 'GIT_DIFF_CHECK_FAILED'}
& git @g commit -S -m 'docs(release): pin Stage11 root staging helper digest and read-only evidence'
if($LASTEXITCODE -ne 0){throw 'GIT_COMMIT_FAILED'}
Write-Output ('STAGE11_CURRENT_HEAD='+(& git @g rev-parse HEAD))
Write-Output ('GPG_SIGNATURE_STATUS='+(& git @g log -1 --format='%G?' HEAD))
Write-Output ('STAGE11_HELPER_SHA256='+((& sha256sum ops/ubuntu/deployment/admission-lock.py) -split ' ')[0])
& git @g status --short --untracked-files=normal
