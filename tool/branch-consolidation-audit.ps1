$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branches = @(& git -C $repo for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin)
foreach ($branch in $branches) {
  if ($branch -eq 'origin/HEAD') { continue }
  $sha = (& git -C $repo rev-parse $branch).Trim()
  $ahead = (& git -C $repo rev-list --count ('master..' + $branch)).Trim()
  $behind = (& git -C $repo rev-list --count ($branch + '..master')).Trim()
  Write-Output ($branch + ' | ' + $sha.Substring(0,12) + ' | unique=' + $ahead + ' | master_unique=' + $behind)
}
