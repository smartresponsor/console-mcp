# Purely isolated transaction executor: no process control, no authenticated receipts.
function Invoke-RuntimeReleaseIsolatedExecutor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][psobject]$InitialSnapshot,
        [ValidateSet('none','before-stop','stop-unknown','start-failed','health-failed','rollback-failed','broker-restarted')]
        [string]$Failure = 'none',
        [ValidateRange(0,20)][int]$InterruptAfterEvents = 0,
        [scriptblock]$ObserveTransition
    )
    $replayed = Read-RuntimeReleaseDurableEvents -Directory $Directory -InitialSnapshot $InitialSnapshot
    if ($replayed.replayed_events -ne 0) { throw 'Cannot resume a previously started isolated transaction.' }
    $snapshot = $replayed.snapshot
    $states = switch ($Failure) {
        'none' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','COMMITTED') }
        'before-stop' { @('ABORTED') }
        'stop-unknown' { @('SWITCH_REQUESTED','RECOVERY_REQUIRED') }
        'broker-restarted' { @('SWITCH_REQUESTED','RECOVERY_REQUIRED') }
        'start-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED','ROLLED_BACK') }
        'health-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED','ROLLED_BACK') }
        'rollback-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','ROLLBACK_REQUESTED','RECOVERY_REQUIRED') }
    }
    foreach ($state in $states) {
        if ($null -ne $ObserveTransition) {
            $observation = & $ObserveTransition $snapshot $state
            if ($null -eq $observation -or $observation -isnot [bool] -or -not $observation) {
                throw 'ISOLATED_BROKER_OBSERVATION_NOT_CONFIRMED'
            }
        }
        $event = [pscustomobject]@{
            transaction_id = $snapshot.transaction_id
            broker_generation = $snapshot.broker_generation
            login_epoch = $snapshot.login_epoch
            sequence = ([long]$snapshot.sequence + 1)
            from_state = $snapshot.status
            to_state = $state
        }
        $snapshot = Add-RuntimeReleaseDurableEvent -Directory $Directory -InitialSnapshot $InitialSnapshot -Event $event
        if ($InterruptAfterEvents -gt 0 -and $snapshot.sequence -eq $InterruptAfterEvents) {
            throw 'INJECTED_RELEASE_EXECUTOR_INTERRUPTION'
        }
    }
    Read-RuntimeReleaseDurableEvents -Directory $Directory -InitialSnapshot $InitialSnapshot
}
