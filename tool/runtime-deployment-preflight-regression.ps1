$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-preflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $candidate = Join-Path $temp 'candidate'
  & git -C $root worktree add --detach $candidate HEAD | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated candidate' }
  $sha = (& git -C $candidate rev-parse HEAD).Trim()
  $output = & pwsh -NoProfile -File $script -WorkspacePath $root -CandidatePath $candidate -ExpectedCommit $sha 2>&1
  $exit = $LASTEXITCODE
  $result = ($output | Out-String | ConvertFrom-Json)
  if ($exit -ne 2 -or $result.status -ne 'DEPLOY_PREFLIGHT_BLOCKED') { throw "Expected blocked candidate, got exit=$exit status=$($result.status)" }
  $build = @($result.checks | Where-Object name -eq 'candidate-build')[0]
  if ($build.passed) { throw 'Missing candidate build incorrectly accepted' }
  $wrongSha = '0000000000000000000000000000000000000000'
  $output2 = & pwsh -NoProfile -File $script -WorkspacePath $root -CandidatePath $candidate -ExpectedCommit $wrongSha 2>&1
  $exit2 = $LASTEXITCODE
  $result2 = ($output2 | Out-String | ConvertFrom-Json)
  if ($exit2 -ne 2 -or (@($result2.checks | Where-Object { $_.name -eq 'candidate-sha' -and -not $_.passed }).Count -ne 1)) { throw 'SHA mismatch was not blocked' }
  Write-Output 'DEPLOY_PREFLIGHT_REGRESSION_PASS'
} finally {
  & git -C $root worktree remove --force $candidate 2>$null | Out-Null
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
