$ErrorActionPreference='Stop'
$pwdPath=(Get-Location).Path
$g=@('-c',"safe.directory=$pwdPath")
Write-Output ('HEAD='+(& git @g rev-parse HEAD))
Write-Output ('BRANCH='+(& git @g branch --show-current))
Write-Output 'DIFF_CHECK:'
& git @g diff --check
if($LASTEXITCODE -ne 0){throw 'DIFF_CHECK_FAILED'}
Write-Output 'TRACKED_DIFF_STAT:'
& git @g diff --stat
Write-Output 'STATUS_SHORT:'
& git @g status --short --untracked-files=normal
