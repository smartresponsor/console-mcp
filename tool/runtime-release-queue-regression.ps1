# Isolated release-switch queue integration. Never starts or stops a process.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path ([System.IO.Path]::GetTempPath()) ('release-queue-' + [guid]::NewGuid().ToString('N'))
function Ensure-Directories { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null }
function Get-ConsoleSessionReport { [pscustomobject]@{ active_console = [pscustomobject]@{ id = 1 } } }
function Sanitize-Text([string]$Text) { $Text }
. (Join-Path $PSScriptRoot 'dev-console.d/85-session-relay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-transaction.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/90-release-journal-schema.ps1')
try {
  Initialize-ServerControlQueue
  $broker = [pscustomobject]@{ generation='live-generation'; login_epoch='live-epoch'; pid=$PID }
  Write-ServerControlBrokerIdentity -Identity $broker
  $journalDir = Get-RuntimeReleaseJournalDirectory -RuntimeDirectory $RunDir
  New-Item -ItemType Directory -Path $journalDir | Out-Null
  $entry = Join-Path $RunDir 'candidate.js'
  Set-Content -LiteralPath $entry -Value 'candidate' -Encoding utf8
  $sha256 = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
  $transaction = [guid]::NewGuid().ToString('N')
  $journal = [pscustomobject]@{
    schema_version=1; transaction_id=$transaction; status='PREPARED'
    candidate_entrypoint=$entry; candidate_sha=('a' * 40); candidate_sha256=$sha256
    expected_broker_generation='live-generation'; expected_login_epoch='live-epoch'
    created_at=[datetimeoffset]::UtcNow.ToString('o'); commit_enabled=$false; runtime_mutated=$false
  }
  Write-ServerControlJsonAtomically -Path (Join-Path $journalDir "$transaction.json") -Value $journal
  $cases = @(
    @{ name='valid'; epoch='live-epoch'; hash=$sha256; expected='RELEASE_SWITCH_COMMIT_NOT_ENABLED' },
    @{ name='stale'; epoch='old-epoch'; hash=$sha256; expected='STALE_BROKER_GENERATION' },
    @{ name='tampered'; epoch='live-epoch'; hash=('0' * 64); expected='RELEASE_SWITCH_INELIGIBLE' }
  )
  foreach ($case in $cases) {
    $id = [guid]::NewGuid().ToString('N')
    $request = [pscustomobject]@{
      schema_version=2; action='release-switch'; correlation_id=$id; request_id=$id
      transaction_id=$transaction; candidate_sha=('a' * 40); candidate_sha256=$case.hash
      candidate_entrypoint=$entry; expected_broker_generation='live-generation'
      expected_login_epoch=$case.epoch; idempotency_key="release-switch:$id"
      requested_at=[datetimeoffset]::UtcNow.ToString('o')
      deadline_at=[datetimeoffset]::UtcNow.AddMinutes(2).ToString('o')
      requested_by_pid=$PID; requested_by_session=0
    }
    Write-ServerControlJsonAtomically -Path (Join-Path $ServerControlInboxDir "$id.json") -Value $request
    $response = Invoke-PendingServerControlRequest
    if (-not $response -or $response.result.status -cne $case.expected -or $response.result.runtime_mutated -eq $true) {
      throw "Queue case $($case.name) failed: $($response | ConvertTo-Json -Depth 8)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ServerControlResponseDir "$id.json"))) { throw 'Durable receipt missing.' }
  }
  Write-Output 'RELEASE_SWITCH_ISOLATED_QUEUE_PASS'
} finally {
  Remove-Item -LiteralPath $RunDir -Recurse -Force -ErrorAction SilentlyContinue
}
