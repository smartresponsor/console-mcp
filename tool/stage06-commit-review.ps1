$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
$files=@('src/index.ts','src/engine/release-transaction-facade-tools.ts','tool/stage06-release-extended-http-regression.mjs','tool/stage06-test-run.ps1','docs/stage06-release-extended-publication.md','tool/stage06-commit-review.ps1')
Write-Output ('STAGE06_PARENT='+(& git @git rev-parse HEAD))
& git @git add -- $files
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){Write-Output 'STAGE06_STAGED_DIFF_FAIL';exit $LASTEXITCODE}
Write-Output 'STAGE06_STAGED_STAT:'
& git @git diff --cached --stat
Write-Output 'STAGE06_SIGNED_COMMIT_BEGIN'
& git @git commit -S -m 'feat(mcp): stage gated Release facade lifecycle extension'
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output ('STAGE06_COMMIT='+(& git @git rev-parse HEAD))
Write-Output 'STAGE06_POST_STATUS:'
& git @git status --porcelain=v1
Write-Output 'STAGE06_COMMIT_PASS'
