# Pure release state simulator: no filesystem, process, or watchdog effects.
function Invoke-RuntimeReleaseSimulation {
    param([ValidateSet('none','before-stop','stop-unknown','start-failed','health-failed','rollback-failed','broker-restarted')][string]$Failure = 'none')
    $state = 'PREPARED'
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
