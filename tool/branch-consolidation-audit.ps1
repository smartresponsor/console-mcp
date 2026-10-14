param([switch]$Mergeability)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branches = @(& git -C $repo for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin)
foreach ($branch in $branches) {
  if ($branch -eq 'origin/HEAD') { continue }
  $sha = (& git -C $repo rev-parse $branch).Trim()
  $ahead = (& git -C $repo rev-list --count ('master..' + $branch)).Trim()
  $behind = (& git -C $repo rev-list --count ($branch + '..master')).Trim()
  Write-Output ($branch + ' | ' + $sha.Substring(0,12) + ' | unique=' + $ahead + ' | master_unique=' + $behind)
  if ($Mergeability -and [int]$ahead -gt 0) {
    $mergeOutput = @(& git -C $repo merge-tree --write-tree master $branch 2>&1)
    $result = if ($LASTEXITCODE -eq 0) { 'CLEAN_MERGE' } else { 'NEEDS_REVIEW' }
    Write-Output ($result + ' | ' + $branch + ' | ' + $sha.Substring(0,12))
  }
}
