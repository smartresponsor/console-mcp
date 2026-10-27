# Replay an ordered event stream into a new immutable snapshot.
# This is structural validation only; caller MUST authenticate the event source.
# Read-only continuity gate. Never infer authority from a matching identity alone.
function Test-RuntimeReleaseBrokerContinuity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][psobject]$Replay,
        [Parameter(Mandatory=$true)][string]$CurrentBrokerGeneration,
        [Parameter(Mandatory=$true)][string]$CurrentLoginEpoch
    )
    if ($null -eq $Replay.snapshot -or -not $Replay.PSObject.Properties['replayed_events']) { return $false }
    if ($Replay.replayed_events -le 0) { return $false }
    if ($Replay.requires_broker_reconciliation) { return $false }
    # The caller-provided authenticated flag is not a broker attestation.
    # Do not grant continuity authority until broker-owned verification exists.
    return $false
    if ($Replay.snapshot.broker_generation -cne $CurrentBrokerGeneration) { return $false }
    if ($Replay.snapshot.login_epoch -cne $CurrentLoginEpoch) { return $false }
    return $true
}
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
