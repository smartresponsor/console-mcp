$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
$files=@('tool/stage07-readiness-audit.ps1','tool/stage07-release-plan-guard.ps1','docs/stage07-release-readiness-20261118.md','tool/stage07-signed-commit.ps1')
Write-Output ('PARENT='+(& git @git rev-parse HEAD))
& git @git add -- $files
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){Write-Output 'STAGE07_DIFF_CHECK_FAILED';exit $LASTEXITCODE}
& git @git commit -S -m 'docs(mcp): verify release provenance and publication gates'
if($LASTEXITCODE -ne 0){Write-Output 'STAGE07_COMMIT_FAILED';exit $LASTEXITCODE}
Write-Output ('COMMIT='+(& git @git rev-parse HEAD))
Write-Output ('SIGNATURE_STATUS='+(& git @git log -1 --format='%G?' HEAD))
Write-Output ('STATUS='+@(& git @git status --porcelain).Count)
Write-Output 'STAGE07_SIGNED_COMMIT_PASS'
