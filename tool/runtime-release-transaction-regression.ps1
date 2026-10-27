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
. (Join-Path $PSScriptRoot 'dev-console.d/90-release-journal-schema.ps1')
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
  # An independent PREPARE must fail closed while another process holds the lock.
  $lockPath = Join-Path $journal '.release-transaction.lock'
  $heldLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $lockRejected = $false
    try {
      New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null
    } catch [System.IO.IOException] {
      $lockRejected = $true
    }
    if (-not $lockRejected) { throw 'PREPARE bypassed an exclusive journal lock.' }
    if (@(Get-ChildItem -LiteralPath $journal -Filter '*.json' -File).Count -ne 0) {
      throw 'Lock contention created a transaction journal.'
    }
  } finally {
    $heldLock.Dispose()
  }
  # Lock artifact persists, but no longer blocks a new PREPARE.
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
  foreach ($terminalState in @('COMMITTED','ROLLED_BACK')) {
    $persisted.status = $terminalState
    Write-ServerControlJsonAtomically -Path $journalPath -Value $persisted
    $blocked = $false
    try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
    catch { $blocked = $true }
    if (-not $blocked) { throw "Unauthenticated $terminalState journal reopened PREPARE." }
  }
  $persisted.status = 'ABORTED'
  Write-ServerControlJsonAtomically -Path $journalPath -Value $persisted
  $terminalRejected = $false
  try { New-RuntimeReleaseTransactionPlan -CandidateEntrypoint $entry -ExpectedCommit $ExpectedCommit -JournalDirectory $journal | Out-Null }
  catch { $terminalRejected = $true }
  if (-not $terminalRejected) { throw 'Unauthenticated terminal journal reopened PREPARE.' }
  Remove-Item -LiteralPath $journalPath -Force
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
  # Evaluate the actual release-switch broker-binding expression against negative cases.
  $relaySource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/85-session-relay.ps1') -Raw
  $binding = [regex]::Match($relaySource, '(?ms)^\s*\$brokerBound = (.+?)\r?\n\s*if \(\$missing\.Count')
  if (-not $binding.Success) { throw 'Release broker-binding guard missing.' }
  $expression = ($binding.Groups[1].Value -replace '\r?\n\s*', ' ')
  $guard = [scriptblock]::Create('$brokerBound = ' + $expression + '; return $brokerBound')
  $broker = [pscustomobject]@{ generation='live-generation'; login_epoch='live-epoch' }
  foreach ($case in @(
    @{ generation='live-generation'; epoch='live-epoch'; allowed=$true },
    @{ generation=''; epoch='live-epoch'; allowed=$false },
    @{ generation='live-generation'; epoch=''; allowed=$false },
    @{ generation='stale-generation'; epoch='live-epoch'; allowed=$false },
    @{ generation='live-generation'; epoch='stale-epoch'; allowed=$false }
  )) {
    $request = [pscustomobject]@{ expected_broker_generation=$case.generation; expected_login_epoch=$case.epoch }
    if ([bool](& $guard) -ne [bool]$case.allowed) { throw "Release broker-binding regression failed for $($case.generation)/$($case.epoch)." }
  }
  Write-Output 'RELEASE_BROKER_IDENTITY_REGRESSION_PASS'
  Write-Output 'RELEASE_TRANSACTION_PREPARE_REGRESSION_PASS'
} finally {
  Remove-Item -LiteralPath $journal -Recurse -Force -ErrorAction SilentlyContinue
}
