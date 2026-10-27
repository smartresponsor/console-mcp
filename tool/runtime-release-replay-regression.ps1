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
# Structural replay never authenticates broker continuity, even at terminal commit.
if (Test-RuntimeReleaseBrokerContinuity -Replay $complete -CurrentBrokerGeneration 'broker' -CurrentLoginEpoch 'epoch') {
    throw 'Unauthenticated terminal replay was accepted.'
}
$authenticated = [pscustomobject]@{
    snapshot = $complete.snapshot
    replayed_events = $complete.replayed_events
    requires_broker_reconciliation = $false
    authenticated = $true
}
if (Test-RuntimeReleaseBrokerContinuity -Replay $authenticated -CurrentBrokerGeneration 'broker' -CurrentLoginEpoch 'epoch') {
    throw 'Caller-forged authenticated terminal replay was accepted.'
}
if (Test-RuntimeReleaseBrokerContinuity -Replay $authenticated -CurrentBrokerGeneration 'restarted-broker' -CurrentLoginEpoch 'epoch') {
    throw 'Broker restart continuity mismatch accepted.'
}
if (Test-RuntimeReleaseBrokerContinuity -Replay $authenticated -CurrentBrokerGeneration 'broker' -CurrentLoginEpoch 'new-login') {
    throw 'Login epoch continuity mismatch accepted.'
}
$inflight = [pscustomobject]@{
    snapshot = $partial.snapshot
    replayed_events = $partial.replayed_events
    requires_broker_reconciliation = $true
    authenticated = $true
}
if (Test-RuntimeReleaseBrokerContinuity -Replay $inflight -CurrentBrokerGeneration 'broker' -CurrentLoginEpoch 'epoch') {
    throw 'Authenticated but incomplete release was accepted without reconciliation.'
}
'RUNTIME_RELEASE_REPLAY_REGRESSION_PASS'
