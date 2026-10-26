$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
$initial = [pscustomobject]@{
    transaction_id = 'test'; broker_generation = 'broker'; login_epoch = 'epoch'
    status = 'PREPARED'; sequence = [long]0
}
function New-ReplayEvent($from,$to,$seq) {
    [pscustomobject]@{
        transaction_id = 'test'; broker_generation = 'broker'; login_epoch = 'epoch'
        from_state = $from; to_state = $to; sequence = $seq
    }
}
$events = @(
    (New-ReplayEvent 'PREPARED' 'SWITCH_REQUESTED' 1),
    (New-ReplayEvent 'SWITCH_REQUESTED' 'STOP_CONFIRMED' 2),
    (New-ReplayEvent 'STOP_CONFIRMED' 'START_REQUESTED' 3),
    (New-ReplayEvent 'START_REQUESTED' 'HEALTH_VERIFYING' 4),
    (New-ReplayEvent 'HEALTH_VERIFYING' 'COMMITTED' 5)
)
$complete = Invoke-RuntimeReleaseReplay -InitialSnapshot $initial -Events $events
if ($complete.snapshot.status -cne 'COMMITTED' -or $complete.requires_broker_reconciliation -or $complete.authenticated) {
    throw 'Complete replay was incorrectly classified.'
}
$partial = Invoke-RuntimeReleaseReplay -InitialSnapshot $initial -Events @($events[0],$events[1])
if ($partial.snapshot.status -cne 'STOP_CONFIRMED' -or -not $partial.requires_broker_reconciliation) {
    throw 'Interrupted release was not marked for reconciliation.'
}
foreach ($bad in @(
    @($events[0],$events[0]),
    @($events[1]),
    @($events[0],$events[2])
)) {
    $rejected = $false
    try { $null = Invoke-RuntimeReleaseReplay -InitialSnapshot $initial -Events $bad } catch { $rejected = $true }
    if (-not $rejected) { throw 'Replay accepted duplicate, missing, or reordered event.' }
}
if ($initial.status -cne 'PREPARED' -or $initial.sequence -ne 0) { throw 'Replay mutated initial snapshot.' }
'RUNTIME_RELEASE_REPLAY_REGRESSION_PASS'
