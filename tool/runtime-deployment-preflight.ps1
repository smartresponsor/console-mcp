# Read-only gate before any release switching. Never stops or starts the server.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WorkspacePath,
  [Parameter(Mandatory=$true)][string]$CandidatePath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit
)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $checks.Add([pscustomobject]@{ name=$Name; passed=$Passed; detail=$Detail })
}
function Invoke-GitCheck([string]$At, [string[]]$GitArguments) {
  $output = & git -C $At @GitArguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArguments -join ' ') failed at $At : $output" }
  return ($output | Out-String).Trim()
}
try {
  $workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
  $candidate = (Resolve-Path -LiteralPath $CandidatePath).Path
  Add-Check 'separate-worktree' ($workspace -ne $candidate) "$workspace != $candidate"
  $activeBranch = Invoke-GitCheck $workspace @('branch','--show-current')
  $dirty = Invoke-GitCheck $workspace @('status','--porcelain')
  Add-Check 'active-checkout-clean' ([string]::IsNullOrWhiteSpace($dirty)) "branch=$activeBranch; dirty=$([bool]$dirty)"
  $candidateSha = Invoke-GitCheck $candidate @('rev-parse','HEAD')
  Add-Check 'candidate-sha' ($candidateSha -ieq $ExpectedCommit) "actual=$candidateSha expected=$ExpectedCommit"
  $candidateDirty = Invoke-GitCheck $candidate @('status','--porcelain')
  Add-Check 'candidate-clean' ([string]::IsNullOrWhiteSpace($candidateDirty)) "dirty=$([bool]$candidateDirty)"
  Add-Check 'candidate-build' (Test-Path -LiteralPath (Join-Path $candidate 'dist/server.js') -PathType Leaf) 'dist/server.js must exist'
  Add-Check 'candidate-dependencies' (Test-Path -LiteralPath (Join-Path $candidate 'node_modules') -PathType Container) 'node_modules must exist'
  $activeCommonDir = Invoke-GitCheck $workspace @('rev-parse','--path-format=absolute','--git-common-dir')
  $candidateCommonDir = Invoke-GitCheck $candidate @('rev-parse','--path-format=absolute','--git-common-dir')
  Add-Check 'same-repository' ($activeCommonDir -ieq $candidateCommonDir) "workspace=$activeCommonDir candidate=$candidateCommonDir"
  Add-Check 'release-directory-not-live' (-not $candidate.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) 'Candidate must not be located within active checkout'
  $failedCount = @($checks | Where-Object { -not $_.passed }).Count
  $ok = $failedCount -eq 0
  [pscustomobject]@{ ok=$ok; status= $(if($ok){'DEPLOY_PREFLIGHT_READY'}else{'DEPLOY_PREFLIGHT_BLOCKED'}); workspace=$workspace; candidate=$candidate; checks=@($checks); next_action='This script never deploys; complete a validated rollback-capable switch mechanism first.' } | ConvertTo-Json -Depth 8
  if (-not $ok) { exit 2 }
} catch {
  [pscustomobject]@{ok=$false;status='DEPLOY_PREFLIGHT_ERROR';error=$_.Exception.Message;checks=@($checks)} | ConvertTo-Json -Depth 8
  exit 3
}
