param([switch]$GitMarkerRegression, [switch]$CommitMarkerRegression)
$ErrorActionPreference = 'Stop'
if ($CommitMarkerRegression) {
  $root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $expected='0f4e810728adb7d659122529fb0b20b40ab70ad1'
  $actual=(& git -c "safe.directory=$root" -C $root rev-parse HEAD).Trim()
  $branch=(& git -c "safe.directory=$root" -C $root branch --show-current).Trim()
  if ($actual -ne $expected -or $branch -ne 'fix/repo-merge-marker-worktree-20261119') { throw 'COMMIT_CAS_MISMATCH' }
  $files=@('src/tool/git-inspection.ts','tool/runtime-deployment-preflight-regression.ps1')
  $status=@(& git -c "safe.directory=$root" -C $root status --porcelain)
  if (@($status | Where-Object { $_ -notmatch '^( M|M |MM) (src/tool/git-inspection.ts|tool/runtime-deployment-preflight-regression.ps1)$' }).Count -gt 0) { throw "UNEXPECTED_WORKTREE_CHANGES: $status" }
  & git -c "safe.directory=$root" -C $root add -- $files
  if ($LASTEXITCODE -ne 0) { throw 'ADD_FAILED' }
  & git -c "safe.directory=$root" -C $root diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw 'DIFF_CHECK_FAILED' }
  $staged=@(& git -c "safe.directory=$root" -C $root diff --cached --name-only)
  if ($staged.Count -ne 2 -or @($staged | Where-Object { $_ -notin $files }).Count -gt 0) { throw "UNEXPECTED_STAGED_FILES: $staged" }
  & git -c "safe.directory=$root" -C $root commit -S -m 'test: exercise linked worktree Git marker resolution'
  if ($LASTEXITCODE -ne 0) { throw 'SIGNED_COMMIT_FAILED' }
  & git -c "safe.directory=$root" -C $root rev-parse HEAD
  exit $LASTEXITCODE
}
if ($GitMarkerRegression) {
  $root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $js=@'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitOperationInProgress } from '../dist/tool/git-inspection.js';
import assert from 'node:assert/strict';
const temp=mkdtempSync(join(tmpdir(),'git-marker-regression-'));
const git=(cwd,...args)=>execFileSync('git',['-c',`safe.directory=${cwd}`,'-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
 const repo=join(temp,'repo');mkdirSync(repo);git(repo,'init');
 const marker=git(repo,'rev-parse','--git-path','MERGE_HEAD');
 writeFileSync(join(repo,marker),'fixture');
 assert.equal(isGitOperationInProgress(repo,['MERGE_HEAD']),true,'normal repo marker');
 rmSync(join(repo,marker));
 assert.equal(isGitOperationInProgress(repo,['MERGE_HEAD']),false,'normal repo no marker');
 const wt=join(temp,'linked');
 git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture');
 git(repo,'worktree','add','--detach',wt,'HEAD');
 const wtMarker=git(wt,'rev-parse','--git-path','MERGE_HEAD');
 writeFileSync(wtMarker,'fixture');
 assert.equal(isGitOperationInProgress(wt,['MERGE_HEAD']),true,'linked worktree marker');
 rmSync(wtMarker);
 assert.equal(isGitOperationInProgress(wt,['MERGE_HEAD']),false,'linked worktree no marker');
 assert.throws(()=>isGitOperationInProgress(join(temp,'nonexistent'),['MERGE_HEAD']),/GIT_OPERATION_STATE_UNVERIFIABLE/,'missing repository fail closed');
 console.log('GIT_MARKER_REGRESSION_PASS');
}finally{rmSync(temp,{recursive:true,force:true})}
'@
  $testPath=Join-Path $root 'tool/.git-marker-regression-tmp.mjs'
  try {
    [System.IO.File]::WriteAllText($testPath,$js,[System.Text.UTF8Encoding]::new($false))
    & node $testPath
    if ($LASTEXITCODE -ne 0) { throw 'GIT_MARKER_REGRESSION_FAILED' }
  } finally { Remove-Item -LiteralPath $testPath -Force -ErrorAction SilentlyContinue }
  exit 0
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Trust only this isolated checkout for this test process and its child processes.
$existingGitConfigCount = 0
if ($env:GIT_CONFIG_COUNT) {
  if (-not [int]::TryParse($env:GIT_CONFIG_COUNT, [ref]$existingGitConfigCount) -or $existingGitConfigCount -lt 0 -or $existingGitConfigCount -ge 1000) {
    throw 'Invalid inherited GIT_CONFIG_COUNT'
  }
}
Set-Item -Path "Env:GIT_CONFIG_KEY_$existingGitConfigCount" -Value 'safe.directory'
Set-Item -Path "Env:GIT_CONFIG_VALUE_$existingGitConfigCount" -Value $root
$env:GIT_CONFIG_COUNT = [string]($existingGitConfigCount + 1)
$script = Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$temp = New-ConsoleTestFixture -Prefix 'cmcp-preflight'
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
  # A dirty active checkout must not block an isolated, fully prepared release.
  $active = Join-Path $temp 'active-dirty'
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
  Remove-ConsoleTestFixture -Path $temp
}
