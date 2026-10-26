# Replay an ordered event stream into a new immutable snapshot.
# This is structural validation only; caller MUST authenticate the event source.
function Invoke-RuntimeReleaseReplay {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][psobject]$InitialSnapshot,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Events
    )
    if ($InitialSnapshot.status -cne 'PREPARED' -or [long]$InitialSnapshot.sequence -ne 0) {
        throw 'Replay must begin at the initial prepared snapshot.'
    }
    $snapshot = [pscustomobject]@{
        transaction_id = [string]$InitialSnapshot.transaction_id
        broker_generation = [string]$InitialSnapshot.broker_generation
        login_epoch = [string]$InitialSnapshot.login_epoch
        status = 'PREPARED'
        sequence = [long]0
    }
    foreach ($event in $Events) {
        $snapshot = Invoke-RuntimeReleaseEvent -Snapshot $snapshot -Event $event
    }
    # In-flight process mutation cannot be inferred safe from structural receipts.
    $uncertain = $snapshot.status -in @('SWITCH_REQUESTED','STOP_CONFIRMED',
        'START_REQUESTED','HEALTH_VERIFYING','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED',
        'RECOVERY_REQUIRED')
    [pscustomobject]@{
        snapshot = $snapshot
        replayed_events = $Events.Count
        requires_broker_reconciliation = [bool]$uncertain
        authenticated = $false
        simulated = $true
    }
}
