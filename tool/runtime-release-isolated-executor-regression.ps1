$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-isolated-executor.ps1')
$expected = @{
    none='COMMITTED'; 'before-stop'='ABORTED'; 'stop-unknown'='RECOVERY_REQUIRED'
    'broker-restarted'='RECOVERY_REQUIRED'; 'start-failed'='ROLLED_BACK'
    'health-failed'='ROLLED_BACK'; 'rollback-failed'='RECOVERY_REQUIRED'
}
foreach ($failure in $expected.Keys) {
    $directory = Join-Path $env:TEMP ('release-executor-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    try {
        $initial = [pscustomobject]@{
            transaction_id='test'; broker_generation='broker'; login_epoch='epoch'
            status='PREPARED'; sequence=[long]0
        }
        $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -Failure $failure
        if ($result.snapshot.status -cne $expected[$failure]) { throw "Wrong final state for $failure" }
        $loaded = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
        if ($loaded.snapshot.status -cne $result.snapshot.status -or
            $loaded.replayed_events -ne $result.replayed_events) { throw "Persistence mismatch for $failure" }
        $rejected = $false
        try { $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -Failure $failure } catch { $rejected = $true }
        if (-not $rejected) { throw "Duplicate execution accepted for $failure" }
    } finally {
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
# Interrupt after every persisted success-path event, including terminal commit.
$lengths = @{ none=5; 'before-stop'=1; 'stop-unknown'=2; 'broker-restarted'=2; 'start-failed'=5; 'health-failed'=7; 'rollback-failed'=6 }
foreach ($failure in $lengths.Keys) {
foreach ($cut in 1..$lengths[$failure]) {
    $directory = Join-Path $env:TEMP ('release-interrupt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    try {
        $initial = [pscustomobject]@{ transaction_id='interrupt'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
        $interrupted = $false
        try {
            $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -Failure $failure -InterruptAfterEvents $cut
        } catch {
            if ($_.Exception.Message -eq 'INJECTED_RELEASE_EXECUTOR_INTERRUPTION') { $interrupted = $true } else { throw }
        }
        if (-not $interrupted) { throw "Interruption injection failed at event $cut." }
        $loaded = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
        if ($loaded.replayed_events -ne $cut -or $loaded.snapshot.sequence -ne $cut) {
            throw "Durable prefix lost at event $cut."
        }
        if ($cut -lt $lengths[$failure] -and -not $loaded.requires_broker_reconciliation) {
            throw "Uncertain interrupted state not flagged at event $cut."
        }
        if ($cut -eq $lengths[$failure] -and $loaded.snapshot.status -cne $expected[$failure]) {
            throw 'Terminal commit not recovered.'
        }
        $rejected = $false
        try { $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial } catch { $rejected = $true }
        if (-not $rejected) { throw "Blind retry accepted after interruption $cut." }
    } finally {
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
}
# An explicit negative broker observation must leave the durable journal empty.
$directory = Join-Path $env:TEMP ('release-denied-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
    $initial = [pscustomobject]@{ transaction_id='denied'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $rejected = $false
    try { $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -ObserveTransition { param($snapshot,$state) $false } } catch { $rejected = ($_.Exception.Message -eq 'ISOLATED_BROKER_OBSERVATION_NOT_CONFIRMED') }
    if (-not $rejected) { throw 'Negative observation was accepted.' }
    $loaded = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
    if ($loaded.replayed_events -ne 0) { throw 'Unconfirmed event was persisted.' }
} finally { Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue }
foreach ($healthCase in @('healthy','unhealthy','missing','exception')) {
    $directory = Join-Path $env:TEMP ('release-health-gate-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    try {
        $initial = [pscustomobject]@{ transaction_id='health-gate'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
        $check = {
            param($snapshot)
            switch ($healthCase) {
                'healthy' { return $true }
                'unhealthy' { return $false }
                'missing' { return $null }
                'exception' { throw 'HEALTH_ENDPOINT_UNAVAILABLE' }
            }
        }.GetNewClosure()
        $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -CheckHealth $check
        $expectedState = if ($healthCase -eq 'healthy') { 'COMMITTED' } else { 'ROLLED_BACK' }
        $expectedEvents = if ($healthCase -eq 'healthy') { 5 } else { 7 }
        if ($result.snapshot.status -cne $expectedState -or $result.replayed_events -ne $expectedEvents) {
            throw "Health gate for $healthCase expected $expectedState, got $($result.snapshot.status)."
        }
    } finally { Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue }
}
'RUNTIME_RELEASE_ISOLATED_EXECUTOR_REGRESSION_PASS'
