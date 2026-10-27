$ErrorActionPreference = 'Stop'
foreach ($name in @('87-release-states','88-release-event-reducer','88-release-replay','88-release-durable-events','88-release-isolated-executor','88-release-process-observer','88-release-health-observer')) { . (Join-Path $PSScriptRoot ('dev-console.d/' + $name + '.ps1')) }
$exe = [string](Get-Process -Id $PID).Path
$fixturePath = Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1'
foreach ($failure in @('none','health-failed')) {
    $holder = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $holder.Start(); $port = ([System.Net.IPEndPoint]$holder.LocalEndpoint).Port; $holder.Stop()
    $endpoint = [uri]("http://127.0.0.1:$port/health")
    $dir = Join-Path $env:TEMP ('release-e2e-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $f = [pscustomobject]@{ Old=$null; OldCreated=$null; New=$null; NewCreated=$null; Restored=$null; RestoredCreated=$null }
    try {
        $f.Old = Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
        $f.OldCreated = [datetimeoffset]$f.Old.StartTime.ToUniversalTime()
        $initial = [pscustomobject]@{ transaction_id=('e2e-' + $failure); broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
        $observer = {
            param($snapshot,$state)
            switch ($state) {
                'SWITCH_REQUESTED' { return (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.Old.Id -CreatedAt $f.OldCreated -Executable $exe) }
                'STOP_CONFIRMED' { $f.Old.Kill(); $null = $f.Old.WaitForExit(10000); return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.Old.Id -CreatedAt $f.OldCreated -Executable $exe)) }
                'START_REQUESTED' {
                    $f.New = Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $fixturePath + '"'),'-Port',$port) -PassThru -WindowStyle Hidden
                    $f.NewCreated = [datetimeoffset]$f.New.StartTime.ToUniversalTime()
                    return (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.New.Id -CreatedAt $f.NewCreated -Executable $exe)
                }
                'HEALTH_VERIFYING' { return (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.New.Id -CreatedAt $f.NewCreated -Executable $exe) }
                'COMMITTED' { return ((Test-RuntimeReleaseIsolatedProcess -ProcessId $f.New.Id -CreatedAt $f.NewCreated -Executable $exe) -and (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000)) }
                'ROLLBACK_REQUESTED' { $f.New.Kill(); $null = $f.New.WaitForExit(10000); return (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.New.Id -CreatedAt $f.NewCreated -Executable $exe)) }
                'OLD_RUNTIME_RESTORED' {
                    $f.Restored = Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
                    $f.RestoredCreated = [datetimeoffset]$f.Restored.StartTime.ToUniversalTime()
                    return (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.Restored.Id -CreatedAt $f.RestoredCreated -Executable $exe)
                }
                'ROLLED_BACK' { return ((Test-RuntimeReleaseIsolatedProcess -ProcessId $f.Restored.Id -CreatedAt $f.RestoredCreated -Executable $exe) -and (-not (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000))) }
                default { return $false }
            }
        }.GetNewClosure()
        $health = {
            param($snapshot)
            if ($failure -eq 'health-failed') { return $false }
            for ($i = 0; $i -lt 30; $i++) {
                if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $f.New.Id -CreatedAt $f.NewCreated -Executable $exe)) { return $false }
                if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000) { return $true }
                Start-Sleep -Milliseconds 100
            }
            return $false
        }.GetNewClosure()
        $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $dir -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer -RequireHealthCheck -CheckHealth $health
        $expected = if ($failure -eq 'none') { 'COMMITTED' } else { 'ROLLED_BACK' }
        $count = if ($failure -eq 'none') { 5 } else { 7 }
        if ($result.snapshot.status -cne $expected -or $result.replayed_events -ne $count) { throw ('Unexpected ' + $failure + ' result.') }
        if (-not $f.Old.HasExited) { throw 'Old child survived transition.' }
        if ($failure -eq 'health-failed' -and (-not $f.New.HasExited -or $f.Restored.HasExited)) { throw 'Rollback process identity mismatch.' }
    } finally {
        foreach ($child in @($f.Old,$f.New,$f.Restored)) { if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) } }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
'RUNTIME_RELEASE_CHILD_E2E_REGRESSION_PASS'
