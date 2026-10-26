# Isolated journal regression: no process start/stop, no live queue mutation.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$WorkspacePath,
 [Parameter(Mandatory=$true)][string]$CandidatePath,
 [Parameter(Mandatory=$true)][string]$ExpectedCommit
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $WorkspacePath).Path
. (Join-Path $PSScriptRoot 'dev-console.d/52-release-entrypoint.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-transaction.ps1')
$script:ServerControlBrokerStateFile = Join-Path $env:TEMP ('release-broker-' + [guid]::NewGuid().ToString('N') + '.json')
function Get-ServerControlBrokerIdentity {
  return [pscustomobject]@{ generation='test-generation'; login_epoch='test-epoch' }
}
function Write-ServerControlJsonAtomically {
  param([string]$Path,$Value)
  $temporary = "$Path.tmp"
  $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
$journal = Join-Path $env:TEMP ('release-journal-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $journal | Out-Null
try {
  $entry = Join-Path $CandidatePath 'dist/index.js'
  $plan = New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal
  if ($plan.status -ne 'PREPARED' -or $plan.commit_enabled -or $plan.runtime_mutated) { throw 'Unexpected prepare result.' }
  $rejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Concurrent unfinished transaction was accepted.' }
  $rejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit ('0' * 40) -JournalDirectory $journal | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Wrong SHA was accepted.' }
  $journalPath = Join-Path $journal "$($plan.transaction_id).json"
  $persisted = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  if ($persisted.transaction_id -ne $plan.transaction_id -or
      $persisted.candidate_sha -ine $ExpectedCommit -or
      $persisted.commit_enabled -ne $false -or
      $persisted.runtime_mutated -ne $false) {
    throw 'Persisted journal does not match prepared transaction.'
  }
  $persisted.status = 'ABORTED'
  Write-ServerControlJsonAtomically -Path $journalPath -Value $persisted
  $next = New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal
  if ($next.transaction_id -eq $plan.transaction_id -or $next.status -ne 'PREPARED') {
    throw 'Terminal transaction did not release single-flight guard.'
  }
  $nextPath = Join-Path $journal "$($next.transaction_id).json"
  Set-Content -LiteralPath $nextPath -Value '{malformed' -Encoding utf8
  $rejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Malformed journal did not fail closed.' }
  Remove-Item -LiteralPath $nextPath -Force
  $unknown = [pscustomobject]@{ status='UNRECOGNIZED' }
  Write-ServerControlJsonAtomically -Path $nextPath -Value $unknown
  $rejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Unknown journal state did not fail closed.' }
  Remove-Item -LiteralPath $nextPath -Force
  Set-Content -LiteralPath (Join-Path $journal 'unexpected.tmp') -Value 'unexpected'
  $rejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Unexpected journal file did not fail closed.' }
  Remove-Item -LiteralPath (Join-Path $journal 'unexpected.tmp') -Force
  Write-Output 'RELEASE_TRANSACTION_PREPARE_REGRESSION_PASS'
} finally {
  Remove-Item -LiteralPath $journal -Recurse -Force -ErrorAction SilentlyContinue
}
