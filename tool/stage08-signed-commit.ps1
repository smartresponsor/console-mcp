$ErrorActionPreference='Stop'
$wd=(Get-Location).Path
$g=@('-c',"safe.directory=$wd")
$expected='eb5e062023cb40341fc75b56ce26524a9a529f16'
$actual=(& git @g rev-parse HEAD).Trim()
if($actual -ne $expected){throw 'SOURCE_BASELINE_CHANGED'}
$files=@('ops/ubuntu/deployment/stage08-authorize-prepare.py','tool/stage08-policy-fixture-test.py','tool/stage08-test-local.ps1','tool/stage08-admin-source-hash.ps1','docs/stage08-exact-sha-admin-runbook-20261118.md','tool/stage08-signed-commit.ps1')
& git @g add -- $files
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @g diff --cached --check
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'STAGED_SCOPE:'
& git @g diff --cached --stat
& git @g commit -S -m 'ops(release): stage prepare-only exact-SHA CAS admin procedure'
if($LASTEXITCODE -ne 0){Write-Output 'SIGNED_COMMIT_FAILED';exit $LASTEXITCODE}
Write-Output ('STAGE08_AUTH_COMMIT='+(& git @g rev-parse HEAD))
Write-Output ('STAGE08_AUTH_SIGNATURE='+(& git @g log -1 --format='%G?' HEAD))
Write-Output 'POST_STATUS:'
& git @g status --porcelain=v1
Write-Output 'STAGE08_AUTH_LOCAL_COMMIT_PASS'
