param([Parameter(Mandatory=$true)][string]$SourceRef, [string]$BaseRef = 'origin/master')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceSha = (& git -C $repo rev-parse --verify ($SourceRef + '^{commit}')).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid source ref' }
$baseSha = (& git -C $repo rev-parse --verify ($BaseRef + '^{commit}')).Trim()
if ($LASTEXITCODE -ne 0 -or $baseSha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid base ref' }
$temp = Join-Path $env:TEMP ('cmcp-merge-review-' + [guid]::NewGuid().ToString('N'))
$attached = $false
try {
  & git -C $repo worktree add --detach $temp $baseSha
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated worktree' }
  $attached = $true
  & git -C $temp -c commit.gpgsign=false merge --no-commit --no-ff $sourceSha
  $mergeExit = $LASTEXITCODE
  $conflicts = @(& git -C $temp diff --name-only --diff-filter=U)
  $diffStat = @(& git -C $temp diff --stat HEAD)
  $payload = [ordered]@{source=$SourceRef;source_sha=$sourceSha;base=$BaseRef;base_sha=$baseSha;clean=($mergeExit -eq 0);conflicts=$conflicts;diff_stat=$diffStat}
  Write-Output ('MERGE_REVIEW ' + ($payload | ConvertTo-Json -Depth 8 -Compress))
} finally {
  if ($attached) {
    & git -C $temp merge --abort 2>$null
    & git -C $repo worktree remove --force $temp
    if ($LASTEXITCODE -ne 0) { Write-Warning ('Worktree removal requires review: ' + $temp) }
  }
}
