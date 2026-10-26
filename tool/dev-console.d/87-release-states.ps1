# Pure state machine for release transaction receipts.
# This module never starts, stops, or inspects a process.
function Test-RuntimeReleaseTransition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$From,
        [Parameter(Mandatory=$true)][string]$To
    )
    $edges = @{
        PREPARED = @('SWITCH_REQUESTED','ABORTED')
        SWITCH_REQUESTED = @('STOP_CONFIRMED','RECOVERY_REQUIRED','ABORTED')
        STOP_CONFIRMED = @('START_REQUESTED','ROLLBACK_REQUESTED','RECOVERY_REQUIRED')
        START_REQUESTED = @('HEALTH_VERIFYING','ROLLBACK_REQUESTED','RECOVERY_REQUIRED')
        HEALTH_VERIFYING = @('COMMITTED','ROLLBACK_REQUESTED','RECOVERY_REQUIRED')
        ROLLBACK_REQUESTED = @('OLD_RUNTIME_RESTORED','RECOVERY_REQUIRED')
        OLD_RUNTIME_RESTORED = @('ROLLED_BACK','RECOVERY_REQUIRED')
        RECOVERY_REQUIRED = @('ROLLBACK_REQUESTED','ABORTED')
        COMMITTED = @()
        ROLLED_BACK = @()
        ABORTED = @()
    }
    # An aborted transaction must not conceal a previously confirmed stop.
    # Recovery after a confirmed stop requires an explicit rollback receipt.
    if ($From -eq 'RECOVERY_REQUIRED' -and $To -eq 'ABORTED') {
        return $false
    }
    if (-not $edges.ContainsKey($From)) { return $false }
    return [bool]($edges[$From] -ccontains $To)
}
