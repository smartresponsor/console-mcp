$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
$initial = [pscustomobject]@{
    transaction_id = 'transaction'
    broker_generation = 'generation'
    login_epoch = 'epoch'
    status = 'PREPARED'
    sequence = [long]0
}
function New-Event($from,$to,$seq) {
    [pscustomobject]@{
        transaction_id = 'transaction'
        broker_generation = 'generation'
        login_epoch = 'epoch'
        from_state = $from
        to_state = $to
        sequence = $seq
    }
}
$first = New-Event 'PREPARED' 'SWITCH_REQUESTED' 1
$next = Invoke-RuntimeReleaseEvent -Snapshot $initial -Event $first
if ($next.status -cne 'SWITCH_REQUESTED' -or $next.sequence -ne 1 -or $initial.status -cne 'PREPARED') {
    throw 'Pure reducer failed to advance without mutating source.'
}
$cases = @(
    (New-Event 'PREPARED' 'SWITCH_REQUESTED' 1),
    (New-Event 'SWITCH_REQUESTED' 'COMMITTED' 2),
    (New-Event 'SWITCH_REQUESTED' 'STOP_CONFIRMED' 3),
    (New-Event 'SWITCH_REQUESTED' 'STOP_CONFIRMED' 0)
)
foreach ($bad in $cases) {
    $rejected = $false
    try { $null = Invoke-RuntimeReleaseEvent -Snapshot $next -Event $bad } catch { $rejected = $true }
    if (-not $rejected) { throw "Unsafe event accepted: $($bad.from_state) -> $($bad.to_state), seq=$($bad.sequence)" }
}
$wrong = New-Event 'SWITCH_REQUESTED' 'STOP_CONFIRMED' 2
$wrong.broker_generation = 'other'
try { $null = Invoke-RuntimeReleaseEvent -Snapshot $next -Event $wrong; throw 'Identity mismatch accepted.' } catch {
    if ($_.Exception.Message -eq 'Identity mismatch accepted.') { throw }
}
$second = Invoke-RuntimeReleaseEvent -Snapshot $next -Event (New-Event 'SWITCH_REQUESTED' 'RECOVERY_REQUIRED' 2)
if (-not $second.recovery_required) { throw 'Recovery state was not flagged.' }
'RUNTIME_RELEASE_EVENT_REDUCER_REGRESSION_PASS'
