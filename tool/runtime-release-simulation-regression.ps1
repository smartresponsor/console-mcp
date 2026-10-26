# Isolated failure matrix: never controls the live runtime.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-simulation.ps1')
$expected = @{
    'none' = 'COMMITTED'
    'before-stop' = 'ABORTED'
    'stop-unknown' = 'RECOVERY_REQUIRED'
    'broker-restarted' = 'RECOVERY_REQUIRED'
    'start-failed' = 'ROLLED_BACK'
    'health-failed' = 'ROLLED_BACK'
    'rollback-failed' = 'RECOVERY_REQUIRED'
}
foreach ($failure in $expected.Keys) {
    $result = Invoke-RuntimeReleaseSimulation -Failure $failure
    if ($result.status -cne $expected[$failure] -or -not $result.simulated) {
        throw "Unexpected simulated outcome for $failure"
    }
    if ($result.recovery_required -ne ($result.status -eq 'RECOVERY_REQUIRED')) {
        throw "Incorrect recovery flag for $failure"
    }
    for ($i = 1; $i -lt $result.history.Count; $i++) {
        if (-not (Test-RuntimeReleaseTransition -From $result.history[$i - 1] -To $result.history[$i])) {
            throw "Invalid transition for $failure"
        }
    }
}
'RUNTIME_RELEASE_SIMULATION_REGRESSION_PASS'
