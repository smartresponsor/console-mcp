$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
$files=@('src/index.ts','tool/mcp-facade-http-regression.mjs','docs/stage04-repo-facade-exclusive-publication.md','tool/stage04-isolated-test-run.ps1','tool/stage04-review.ps1','tool/stage04-signed-commit.ps1')
Write-Output ('BASELINE='+(& git @git rev-parse HEAD))
& git @git diff --check
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @git add -- $files
if($LASTEXITCODE -ne 0){Write-Output 'STAGE04_STAGE_FAIL';exit $LASTEXITCODE}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){Write-Output 'STAGE04_STAGED_DIFF_FAIL';exit $LASTEXITCODE}
Write-Output 'STAGE04_SIGNED_COMMIT_BEGIN'
& git @git commit -S -m 'fix(mcp): publish Repo Git tools exclusively via Repo facade'
if($LASTEXITCODE -ne 0){Write-Output 'STAGE04_SIGNED_COMMIT_UNAVAILABLE';exit $LASTEXITCODE}
Write-Output ('STAGE04_COMMIT='+(& git @git rev-parse HEAD))
& git @git status --short
Write-Output 'STAGE04_SIGNED_COMMIT_PASS'
