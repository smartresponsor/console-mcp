$ErrorActionPreference='Stop'
$wd=(Get-Location).Path
$g=@('-c',"safe.directory=$wd")
$base=(& git @g rev-parse HEAD).Trim()
if($base -ne '23cd0a10c705e995284c6053c20a0977bd51bc1b'){throw 'STAGE09_BASELINE_CHANGED'}
$files=@('ops/ubuntu/deployment/stage09-authorize-validate.py','tool/stage09-policy-fixture-test.py','tool/stage09-test-local.ps1','docs/stage09-validation-admin-runbook-20261118.md','tool/stage09-signed-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'STAGE09_DIFF_STAT:'
& git @g diff --cached --stat
& git @g commit -S -m 'ops(release): stage validate-only exact deployment authorization'
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output ('STAGE09_COMMIT='+(& git @g rev-parse HEAD))
Write-Output ('STAGE09_SIGNATURE='+(& git @g log -1 --format='%G?' HEAD))
Write-Output 'STAGE09_STATUS:'
& git @g status --porcelain=v1
Write-Output 'STAGE09_SCOPED_COMMIT_PASS'
