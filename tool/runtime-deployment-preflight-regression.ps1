$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$temp = New-ConsoleTestFixture -Prefix 'cmcp-preflight'
$candidate = Join-Path $temp 'candidate'
$active = Join-Path $temp 'active-dirty'
# Process-local test config only; never change the operator's global Git configuration.
$priorGitConfigGlobal = $env:GIT_CONFIG_GLOBAL
$testGitConfig = Join-Path $temp 'git-test-config'
@($root, $candidate, $active) | ForEach-Object { "[safe]`n`tdirectory = `"$($_.Replace('\', '\\'))`"" } | Set-Content -LiteralPath $testGitConfig -Encoding utf8
$env:GIT_CONFIG_GLOBAL = $testGitConfig
try {
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
  # A dirty active checkout must not block an isolated, fully prepared release.
  & git -C $root worktree add --detach $active HEAD | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated active worktree' }
  try {
    Set-Content -LiteralPath (Join-Path $active 'local-unsaved-change.txt') -Value 'preserve me'
    New-Item -ItemType Directory -Path (Join-Path $candidate 'dist') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $candidate 'node_modules') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $candidate 'dist/index.js') -Value '// regression fixture only'
    $preparedOutput = & pwsh -NoProfile -File $script -WorkspacePath $active -CandidatePath $candidate -ExpectedCommit $sha 2>&1
    $preparedExit = $LASTEXITCODE
    $prepared = ($preparedOutput | Out-String | ConvertFrom-Json)
    if ($preparedExit -ne 0 -or $prepared.status -ne 'DEPLOY_PREFLIGHT_READY') { throw "Dirty checkout unexpectedly blocked: exit=$preparedExit status=$($prepared.status)" }
    if (@($prepared.checks | Where-Object { $_.name -eq 'active-checkout-observed' -and $_.passed }).Count -ne 1) { throw 'Active checkout preservation not reported' }
    if (-not (Test-Path -LiteralPath (Join-Path $active 'local-unsaved-change.txt'))) { throw 'Active checkout data changed' }
  } finally {
    & git -C $root worktree remove --force $active 2>$null | Out-Null
  }
  Write-Output 'DEPLOY_PREFLIGHT_REGRESSION_PASS'
} finally {
  & git -C $root worktree remove --force $candidate 2>$null | Out-Null
  if ($null -eq $priorGitConfigGlobal) { Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_GLOBAL = $priorGitConfigGlobal }
  Remove-ConsoleTestFixture -Path $temp
}
