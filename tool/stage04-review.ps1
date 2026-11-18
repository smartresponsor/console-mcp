$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
Write-Output 'HEAD:'
& git @git rev-parse HEAD
Write-Output 'STATUS:'
& git @git status --short
Write-Output 'DIFF_CHECK:'
& git @git diff --check
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'DIFF_NUMSTAT:'
& git @git diff --numstat
Write-Output 'SCOPE:'
& git @git diff --name-only
Write-Output 'GIT_REVIEW_PASS'
