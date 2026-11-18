$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
$files=@('src/index.ts','tool/mcp-facade-http-regression.mjs','docs/stage05-transaction-transport-exclusive-publication.md','tool/stage05-signed-commit.ps1')
Write-Output ('STAGE05_PARENT='+(& git @git rev-parse HEAD))
& git @git add -- $files
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& git @git diff --cached --check
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'STAGE05_SIGNED_COMMIT_BEGIN'
& git @git commit -S -m 'fix(mcp): publish transaction and transport via facades only'
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output ('STAGE05_COMMIT='+(& git @git rev-parse HEAD))
& git @git status --porcelain=v1
Write-Output 'STAGE05_SIGNED_COMMIT_PASS'
