# Pure event reducer for a future authenticated broker. No process or journal I/O.
# Caller must authenticate the event before invoking this reducer.
function Invoke-RuntimeReleaseEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][psobject]$Snapshot,
        [Parameter(Mandatory=$true)][psobject]$Event
    )
    $required = @('transaction_id','broker_generation','login_epoch','sequence','from_state','to_state')
    foreach ($key in $required) {
        if (-not $Event.PSObject.Properties[$key] -or [string]::IsNullOrWhiteSpace([string]$Event.$key)) {
            throw "Missing release event field: $key"
        }
    }
    if ($Snapshot.transaction_id -cne $Event.transaction_id -or
        $Snapshot.broker_generation -cne $Event.broker_generation -or
        $Snapshot.login_epoch -cne $Event.login_epoch) {
        throw 'Release event identity mismatch.'
    }
    if ($Event.from_state -cne $Snapshot.status) { throw 'Stale release event state.' }
    $seq = [long]0
    if (-not [long]::TryParse([string]$Event.sequence, [ref]$seq) -or
        $seq -le 0 -or $Snapshot.sequence -ge [long]::MaxValue -or
        $seq -ne ([long]$Snapshot.sequence + 1)) {
        throw 'Release event sequence gap, replay, or overflow.'
    }
    if (-not (Test-RuntimeReleaseTransition -From $Snapshot.status -To $Event.to_state)) {
        throw 'Illegal release event transition.'
    }
    # The return is a new snapshot: no mutation of caller-owned state.
    [pscustomobject]@{
        transaction_id = [string]$Snapshot.transaction_id
        broker_generation = [string]$Snapshot.broker_generation
        login_epoch = [string]$Snapshot.login_epoch
        status = [string]$Event.to_state
        sequence = $seq
        recovery_required = ($Event.to_state -eq 'RECOVERY_REQUIRED')
        simulated = $true
    }
}
