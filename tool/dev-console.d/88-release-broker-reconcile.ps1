# Read-only reconciliation. Never promotes a journal claim into broker authority.
function Get-RuntimeReleaseBrokerRuntimeReconciliation {
    param([Parameter(Mandatory=$true)]$Controller,[Parameter(Mandatory=$true)]$Snapshot,[Parameter(Mandatory=$true)][int]$OldProcessId,[Parameter(Mandatory=$true)][datetimeoffset]$OldCreatedAt,[Parameter(Mandatory=$true)][string]$OldExecutable,[Parameter(Mandatory=$true)][int]$ReplacementProcessId,[Parameter(Mandatory=$true)][datetimeoffset]$ReplacementCreatedAt,[Parameter(Mandatory=$true)][string]$ReplacementExecutable,[Parameter(Mandatory=$true)][uri]$HealthUri)
    if ($Controller.state -cne 'RECOVERY_REQUIRED' -or [string]$Controller.active_transaction -cne [string]$Snapshot.transaction_id) { throw 'BROKER_RECONCILIATION_NOT_ADMITTED' }
    $oldAlive = Test-RuntimeReleaseIsolatedProcess -ProcessId $OldProcessId -CreatedAt $OldCreatedAt -Executable $OldExecutable
    $newAlive = Test-RuntimeReleaseIsolatedProcess -ProcessId $ReplacementProcessId -CreatedAt $ReplacementCreatedAt -Executable $ReplacementExecutable
    $newHealthy = $false
    if ($newAlive) { $newHealthy = Test-RuntimeReleaseIsolatedHttpHealth -Uri $HealthUri -TimeoutMs 1000 }
    $classification = 'UNKNOWN'
    if ($oldAlive -and -not $newAlive) { $classification = 'OLD_RUNTIME_ONLY' }
    if (-not $oldAlive -and $newAlive -and $newHealthy) { $classification = 'REPLACEMENT_HEALTHY' }
    if ($oldAlive -and $newAlive) { $classification = 'BOTH_RUNNING' }
    if (-not $oldAlive -and -not $newAlive) { $classification = 'NEITHER_RUNNING' }
    [pscustomobject]@{ transaction_id=$Controller.active_transaction; journal_state=[string]$Snapshot.status; classification=$classification; old_process_alive=[bool]$oldAlive; replacement_process_alive=[bool]$newAlive; replacement_http_healthy=[bool]$newHealthy; mutation_authorized=$false; automatic_commit_allowed=$false }
}
