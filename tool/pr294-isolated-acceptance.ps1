param()
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedHead = 'd0a8491f7a95383925707e50615f7f63bd6c9bb8'
$head = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $expectedHead) { throw "Unexpected baseline HEAD: $head" }
$branch = (& git -C $repo branch --show-current).Trim()
if ($branch -ne 'checkpoint/pr294-cas-path-multiprocess-lease-20261116') { throw "Unexpected branch: $branch" }
& git -C $repo diff --check
if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed' }
$tests = @(
  'release-policy-cas-regression.py',
  'release-policy-snapshot-regression.py',
  'pr294-offline-root-security-regression.py'
)
foreach ($name in $tests) {
  $test = Join-Path $repo ('ops/ubuntu/deployment/' + $name)
  Write-Output ("=== " + $name + " ===")
  & /usr/bin/python3 -B $test -v
  if ($LASTEXITCODE -ne 0) { throw ("Regression failed: " + $name) }
}
Write-Output ("PR294_LOCAL_PYTHON_ACCEPTANCE_COMPLETED BASE_SHA=" + $head)
Write-Output 'ROOT_ONLY_TESTS_MUST_BE_REPORTED_SEPARATELY; SKIPPED IS NOT PASS'
$dirty = & git -C $repo status --porcelain
Write-Output ("WORKTREE_DIRTY_ENTRIES=" + @($dirty).Count)
Write-Output (& git -C $repo diff --stat)
