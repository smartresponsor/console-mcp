# Pure release state simulator: no filesystem, process, or watchdog effects.
function Invoke-RuntimeReleaseSimulation {
    param([ValidateSet('none','before-stop','stop-unknown','start-failed','health-failed','rollback-failed','broker-restarted')][string]$Failure = 'none')
    $snapshot = [pscustomobject]@{
        transaction_id = 'simulation-transaction'
        broker_generation = 'simulation-broker'
        login_epoch = 'simulation-epoch'
        status = 'PREPARED'
        sequence = [long]0
    }
    $state = $snapshot.status
    $history = [System.Collections.Generic.List[string]]::new()
    $history.Add($state)
    $path = switch ($Failure) {
        'none' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','COMMITTED') }
        'before-stop' { @('ABORTED') }
        'stop-unknown' { @('SWITCH_REQUESTED','RECOVERY_REQUIRED') }
        'broker-restarted' { @('SWITCH_REQUESTED','RECOVERY_REQUIRED') }
        'start-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED','ROLLED_BACK') }
        'health-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED','ROLLED_BACK') }
        'rollback-failed' { @('SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED','HEALTH_VERIFYING','ROLLBACK_REQUESTED','RECOVERY_REQUIRED') }
    }
    foreach ($next in $path) {
        $event = [pscustomobject]@{
            transaction_id = $snapshot.transaction_id
            broker_generation = $snapshot.broker_generation
            login_epoch = $snapshot.login_epoch
            from_state = $snapshot.status
            to_state = $next
            sequence = ([long]$snapshot.sequence + 1)
        }
        $snapshot = Invoke-RuntimeReleaseEvent -Snapshot $snapshot -Event $event
        if (-not (Test-RuntimeReleaseTransition -From $state -To $next)) {
            throw "Invalid simulated release transition: $state -> $next"
        }
        $state = $next
        $history.Add($state)
    }
    [pscustomobject]@{
        status = $state
        history = @($history.ToArray())
        runtime_mutated = ($history -contains 'STOP_CONFIRMED')
        recovery_required = ($state -eq 'RECOVERY_REQUIRED')
        simulated = $true
    }
}
