$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-process-observer.ps1')
$self = Get-Process -Id $PID -ErrorAction Stop
$created = [datetimeoffset]$self.StartTime.ToUniversalTime()
$path = [string]$self.Path
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Fixture process executable unavailable.' }
if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created -Executable $path)) {
    throw 'Live fixture identity was rejected.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created.AddMinutes(-5) -Executable $path) {
    throw 'Stale process identity was accepted.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created -Executable ($path + '.other')) {
    throw 'Executable mismatch was accepted.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId 2147483647 -CreatedAt $created -Executable $path) {
    throw 'Missing process was accepted.'
}
# The only process stopped here is a child spawned by this regression.
$child = $null
try {
    $child = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20') -PassThru -WindowStyle Hidden
    $child.Refresh()
    $childCreated = [datetimeoffset]$child.StartTime.ToUniversalTime()
    if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path)) {
        throw 'Isolated child was not observed as running.'
    }
    if (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated.AddMinutes(-2) -Executable $path) {
        throw 'Child PID reuse guard failed.'
    }
} finally {
    if ($null -ne $child) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(10000) | Out-Null }
    }
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path) {
    throw 'Stopped isolated child was still observed as running.'
}
# Link an observed, regression-owned child to the durable isolated executor.
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-isolated-executor.ps1')
$directory = Join-Path $env:TEMP ('release-observed-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$child = $null
try {
    $initial = [pscustomobject]@{ transaction_id='observed'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $child = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20') -PassThru -WindowStyle Hidden
    $child.Refresh()
    $childCreated = [datetimeoffset]$child.StartTime.ToUniversalTime()
    $observer = {
        param($snapshot,$state)
        if ($state -eq 'SWITCH_REQUESTED') {
            return (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path)
        }
        if ($state -eq 'STOP_CONFIRMED') {
            if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(10000) | Out-Null }
            return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path))
        }
        return $false
    }.GetNewClosure()
    $denied = $false
    try {
        $null = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer
    } catch {
        $denied = ($_.Exception.Message -eq 'ISOLATED_BROKER_OBSERVATION_NOT_CONFIRMED')
    }
    if (-not $denied) { throw 'Executor accepted an unobserved start transition.' }
    $replayed = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
    if ($replayed.snapshot.status -cne 'STOP_CONFIRMED' -or $replayed.replayed_events -ne 2) {
        throw 'Observed stop was not durably recorded.'
    }
} finally {
    if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit(10000) | Out-Null }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
'RUNTIME_RELEASE_PROCESS_OBSERVER_REGRESSION_PASS'
