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
foreach ($cut in 1..5) {
    $directory = Join-Path $env:TEMP ('release-interrupt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    try {
        $initial = [pscustomobject]@{ transaction_id='interrupt'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
        $interrupted = $false
        try {
            $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -InterruptAfterEvents $cut
        } catch {
            if ($_.Exception.Message -eq 'INJECTED_RELEASE_EXECUTOR_INTERRUPTION') { $interrupted = $true } else { throw }
        }
        if (-not $interrupted) { throw "Interruption injection failed at event $cut." }
        $loaded = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
        if ($loaded.replayed_events -ne $cut -or $loaded.snapshot.sequence -ne $cut) {
            throw "Durable prefix lost at event $cut."
        }
        if ($cut -lt 5 -and -not $loaded.requires_broker_reconciliation) {
            throw "Uncertain interrupted state not flagged at event $cut."
        }
        if ($cut -eq 5 -and $loaded.snapshot.status -cne 'COMMITTED') {
            throw 'Terminal commit not recovered.'
        }
        $rejected = $false
        try { $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial } catch { $rejected = $true }
        if (-not $rejected) { throw "Blind retry accepted after interruption $cut." }
    } finally {
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
'RUNTIME_RELEASE_ISOLATED_EXECUTOR_REGRESSION_PASS'
