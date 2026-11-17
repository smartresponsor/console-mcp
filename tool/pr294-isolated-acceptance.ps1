param()
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sha = (& git -C $repo rev-parse 'origin/fix/issue-288-policy-cas-integration').Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve exact PR head' }
$isolated = Join-Path ([System.IO.Path]::GetTempPath()) ('pr294-acceptance-' + [guid]::NewGuid().ToString('N'))
try {
  & git -C $repo worktree add --detach $isolated $sha
  if ($LASTEXITCODE -ne 0) { throw 'Isolated worktree creation failed' }
  $status = & git -C $isolated status --porcelain
  if ($status) { throw 'New checkout not clean' }
  foreach ($name in @('release-policy-cas-regression.py', 'release-policy-snapshot-regression.py')) {
    $test = Join-Path $isolated ('ops/ubuntu/deployment/' + $name)
    & /usr/bin/python3 -B $test
    if ($LASTEXITCODE -ne 0) { throw ('Acceptance failure: ' + $name) }
  }
  Write-Output ('PR294_ISOLATED_PYTHON_PASS SHA=' + $sha)
  Write-Output 'PR294_ROOT_ONLY_PENDING: invoke the separately authorized offline root runner; no sudo from Console MCP'
  exit 2
}
finally {
  if (Test-Path $isolated) {
    & git -C $repo worktree remove --force $isolated
  }
}
