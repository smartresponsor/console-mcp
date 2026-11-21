$ErrorActionPreference='Stop'
$wd=(Get-Location).Path
$g=@('-c',"safe.directory=$wd")
if((& git @g rev-parse HEAD).Trim() -ne 'eb5e062023cb40341fc75b56ce26524a9a529f16'){throw 'BASELINE_DRIFT'}
$files=@('ops/ubuntu/deployment/admission-lock.py','tool/stage11-admission-lock-fixture.py','tool/stage11-admission-test.ps1','docs/stage11-deployment-admission-20261118.md','tool/stage11-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){throw 'GIT_ADD_FAILED'}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){throw 'DIFF_CHECK_FAILED'}
& git @g commit -S -m 'ops(release): prototype cross-process deployment admission barrier'
if($LASTEXITCODE -ne 0){throw 'COMMIT_FAILED'}
Write-Output ('STAGE11_COMMIT='+(& git @g rev-parse HEAD))
Write-Output ('STAGE11_SIGNATURE='+(& git @g log -1 --format='%G?' HEAD))
& git @g status --porcelain=v1
