param()
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:TMPDIR = '/tmp'
$env:TEMP = '/tmp'
$env:TMP = '/tmp'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedParent = 'eb17f954ff1dadb456d20f7e4552f6b10d743501'
$head = (& git -C $repo rev-parse HEAD).Trim()
$parent = (& git -C $repo rev-parse HEAD^).Trim()
if ($LASTEXITCODE -ne 0 -or $parent -ne $expectedParent) { throw "Unexpected acceptance commit parent: $parent (HEAD: $head)" }
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
  $output = & /usr/bin/python3 -B $test -v 2>&1
  $output | ForEach-Object { Write-Output $_ }
  if ($LASTEXITCODE -ne 0) { throw ("Regression failed: " + $name) }
  if ($name -ne 'pr294-offline-root-security-regression.py' -and ($output -join "`n") -match 'skipped=[1-9][0-9]*') { throw ("Unexpected skipped tests: " + $name) }
}
Write-Output ("PR294_UNPRIVILEGED_ACCEPTANCE_COMPLETED BASE_SHA=" + $head)
Write-Output 'NOTE: root-identity/mode enforcement remains a deferred privilege-specific check; this run is not a root receipt.'
$dirty = & git -C $repo status --porcelain
Write-Output ("WORKTREE_DIRTY_ENTRIES=" + @($dirty).Count)
Write-Output (& git -C $repo diff --stat)
