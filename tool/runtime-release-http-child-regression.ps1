$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-health-observer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-process-observer.ps1')
$self = Get-Process -Id $PID
$exe = [string]$self.Path
if (-not $exe) { throw 'PowerShell executable not available.' }
$portHolder = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portHolder.Start()
$port = ([System.Net.IPEndPoint]$portHolder.LocalEndpoint).Port
$portHolder.Stop()
$endpoint = [uri]("http://127.0.0.1:$port/health")
$child = $null
try {
    $fixturePath = Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1'
    $child = Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $fixturePath + '"'),'-Port',$port) -PassThru -WindowStyle Hidden
    $created = [datetimeoffset]$child.StartTime.ToUniversalTime()
    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        if ($child.HasExited) { throw 'Child HTTP service exited before health check.' }
        if ((Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $created -Executable $exe) -and (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000)) { $healthy = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $healthy) { throw 'Child process identity and HTTP health never agreed.' }
    $child.Kill()
    $null = $child.WaitForExit(10000)
    if (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $created -Executable $exe) { throw 'Stopped child still passed identity check.' }
    if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000) { throw 'Stopped child still passed HTTP health check.' }
} finally {
    if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) }
}
# Exercise the durable isolated executor against the same live child-owned HTTP endpoint.
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-isolated-executor.ps1')
$directory = Join-Path $env:TEMP ('release-child-http-executor-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$replacement = [pscustomobject]@{ Process=$null; CreatedAt=$null }
try {
    $initial = [pscustomobject]@{ transaction_id='child-http-success'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $observer = {
        param($snapshot,$state)
        if ($state -eq 'SWITCH_REQUESTED' -or $state -eq 'STOP_CONFIRMED') { return $true } # No old runtime exists in this fixture.
        if ($state -eq 'START_REQUESTED') {
            $replacement.Process = Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $fixturePath + '"'),'-Port',$port) -PassThru -WindowStyle Hidden
            $replacement.CreatedAt = [datetimeoffset]$replacement.Process.StartTime.ToUniversalTime()
        }
        if ($null -eq $replacement.Process) { return $false }
        return (Test-RuntimeReleaseIsolatedProcess -ProcessId $replacement.Process.Id -CreatedAt $replacement.CreatedAt -Executable $exe)
    }.GetNewClosure()
    $health = {
        param($snapshot)
        for ($i = 0; $i -lt 30; $i++) {
            if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $replacement.Process.Id -CreatedAt $replacement.CreatedAt -Executable $exe)) { return $false }
            if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000) { return $true }
            Start-Sleep -Milliseconds 100
        }
        return $false
    }.GetNewClosure()
    $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer -RequireHealthCheck -CheckHealth $health
    if ($result.snapshot.status -cne 'COMMITTED' -or $result.replayed_events -ne 5) {
        throw 'Observed child-hosted HTTP success did not commit.'
    }
} finally {
    if ($null -ne $replacement.Process -and -not $replacement.Process.HasExited) {
        $replacement.Process.Kill()
        $null = $replacement.Process.WaitForExit(10000)
    }
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
'RUNTIME_RELEASE_HTTP_CHILD_REGRESSION_PASS'
