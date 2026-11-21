$ErrorActionPreference='Stop'
$path=(Get-Location).Path
$g=@('-c',"safe.directory=$path")
if((& git @g rev-parse HEAD).Trim() -ne '0186768ce3180865c1b481cceb39f12dfe221241'){throw 'BASELINE_MISMATCH'}
$files=@('src/Infrastructure/Process/AsyncCommandRun.ts','src/tool/powershell-script.ts','tool/stage11-unpublished-child-regression.mjs','tool/stage11-postspawn-state-failure-regression.mjs','tool/stage11-integration-tests.ps1','docs/stage11-deployment-admission-20261118.md','tool/stage11-lifecycle-security-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){throw 'GIT_ADD_FAIL'}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){throw 'GIT_DIFF_CHECK_FAIL'}
& git @g diff --cached --stat
& git @g commit -S -m 'fix(release): reap unpublished async children before admission unlock'
if($LASTEXITCODE -ne 0){throw 'GIT_COMMIT_FAIL'}
Write-Output ('STAGE11_SECURITY_COMMIT='+(& git @g rev-parse HEAD))
Write-Output ('SIGNATURE='+(& git @g log -1 --format='%G?' HEAD))
& git @g status --short --untracked-files=normal
