$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-process-observer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-health-observer.ps1')
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
# Verify observed stop, observed replacement start, and observed health.
$directory = Join-Path $env:TEMP ('release-observed-success-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$old = $null
$new = $null
try {
    $initial = [pscustomobject]@{ transaction_id='observed-success'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $old = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
    $oldCreated = [datetimeoffset]$old.StartTime.ToUniversalTime()
    $replacement = [pscustomobject]@{ Process=$null; CreatedAt=$null }
    $observer = {
        param($snapshot,$state)
        switch ($state) {
            'SWITCH_REQUESTED' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $old.Id -CreatedAt $oldCreated -Executable $path)
            }
            'STOP_CONFIRMED' {
                if (-not $old.HasExited) { $old.Kill(); $old.WaitForExit(10000) | Out-Null }
                return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $old.Id -CreatedAt $oldCreated -Executable $path))
            }
            'START_REQUESTED' {
                $replacement.Process = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
                $replacement.CreatedAt = [datetimeoffset]$replacement.Process.StartTime.ToUniversalTime()
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $replacement.Process.Id -CreatedAt $replacement.CreatedAt -Executable $path)
            }
            'HEALTH_VERIFYING' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $replacement.Process.Id -CreatedAt $replacement.CreatedAt -Executable $path)
            }
            'COMMITTED' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $replacement.Process.Id -CreatedAt $replacement.CreatedAt -Executable $path)
            }
            default { return $false }
        }
    }.GetNewClosure()
    $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer
    if ($result.snapshot.status -cne 'COMMITTED' -or $result.replayed_events -ne 5) {
        throw 'Observed isolated replacement did not commit.'
    }
} finally {
    foreach ($process in @($old,$replacement.Process)) {
        if ($null -ne $process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit(10000) | Out-Null }
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
# Rollback: replacement process is observed unhealthy, then the old fixture is restored.
$directory = Join-Path $env:TEMP ('release-observed-rollback-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$fixture = [pscustomobject]@{ Old=$null; OldCreated=$null; New=$null; NewCreated=$null; Restored=$null; RestoredCreated=$null }
try {
    $initial = [pscustomobject]@{ transaction_id='observed-rollback'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $fixture.Old = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
    $fixture.OldCreated = [datetimeoffset]$fixture.Old.StartTime.ToUniversalTime()
    $observer = {
        param($snapshot,$state)
        switch ($state) {
            'SWITCH_REQUESTED' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.Old.Id -CreatedAt $fixture.OldCreated -Executable $path)
            }
            'STOP_CONFIRMED' {
                if (-not $fixture.Old.HasExited) { $fixture.Old.Kill(); $fixture.Old.WaitForExit(10000) | Out-Null }
                return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.Old.Id -CreatedAt $fixture.OldCreated -Executable $path))
            }
            'START_REQUESTED' {
                $fixture.New = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
                $fixture.NewCreated = [datetimeoffset]$fixture.New.StartTime.ToUniversalTime()
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.New.Id -CreatedAt $fixture.NewCreated -Executable $path)
            }
            'HEALTH_VERIFYING' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.New.Id -CreatedAt $fixture.NewCreated -Executable $path)
            }
            'ROLLBACK_REQUESTED' {
                if (-not $fixture.New.HasExited) { $fixture.New.Kill(); $fixture.New.WaitForExit(10000) | Out-Null }
                return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.New.Id -CreatedAt $fixture.NewCreated -Executable $path))
            }
            'OLD_RUNTIME_RESTORED' {
                $fixture.Restored = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
                $fixture.RestoredCreated = [datetimeoffset]$fixture.Restored.StartTime.ToUniversalTime()
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.Restored.Id -CreatedAt $fixture.RestoredCreated -Executable $path)
            }
            'ROLLED_BACK' {
                return (Test-RuntimeReleaseIsolatedProcess -ProcessId $fixture.Restored.Id -CreatedAt $fixture.RestoredCreated -Executable $path)
            }
            default { return $false }
        }
    }.GetNewClosure()
    $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer -CheckHealth { Test-RuntimeReleaseIsolatedHttpHealth -Uri 'http://127.0.0.1:1/health' -TimeoutMs 1000 }
    if ($result.snapshot.status -cne 'ROLLED_BACK' -or $result.replayed_events -ne 7) {
        throw 'Observed isolated rollback did not complete.'
    }
} finally {
    foreach ($process in @($fixture.Old,$fixture.New,$fixture.Restored)) {
        if ($null -ne $process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit(10000) | Out-Null }
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
'RUNTIME_RELEASE_PROCESS_OBSERVER_REGRESSION_PASS'
