# Fail-closed startup reconciliation for an isolated broker controller.
# A caller must supply a trusted broker-local transaction directory; this is not authentication of shared files.
function Initialize-RuntimeReleaseBrokerFromDurableJournal {
    param([Parameter(Mandatory=$true)]$Controller,[Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)]$InitialSnapshot)
    if ($Controller.state -cne 'IDLE' -or $null -ne $Controller.active_transaction) { throw 'BROKER_CONTROLLER_ALREADY_INITIALIZED' }
    # Reserve admission before touching potentially malformed or attacker-controlled journal contents.
    $Controller.state = 'RECOVERY_REQUIRED'
    $Controller.active_transaction = [string]$InitialSnapshot.transaction_id
    if ([string]::IsNullOrWhiteSpace($Controller.active_transaction)) { throw 'BROKER_JOURNAL_TRANSACTION_REQUIRED' }
    $read = Read-RuntimeReleaseDurableEvents -Directory $Directory -InitialSnapshot $InitialSnapshot
    if ($null -eq $read -or $null -eq $read.snapshot) { throw 'BROKER_JOURNAL_UNAVAILABLE' }
    if ([string]$read.snapshot.transaction_id -cne $Controller.active_transaction) { throw 'BROKER_JOURNAL_TRANSACTION_MISMATCH' }
    if ([string]$read.snapshot.broker_generation -cne $Controller.generation -or [string]$read.snapshot.login_epoch -cne $Controller.login_epoch) {
        # Stale generation or login epoch must never silently re-enter an active transaction.
        return [pscustomobject]@{ status='RECOVERY_REQUIRED'; reason='BROKER_IDENTITY_CHANGED'; journal_state=$read.snapshot.status }
    }
    # Even a terminal event is only a journal claim, not independent runtime observation.
    return [pscustomobject]@{ status='RECOVERY_REQUIRED'; reason='RUNTIME_RECONCILIATION_REQUIRED'; journal_state=$read.snapshot.status }
}
