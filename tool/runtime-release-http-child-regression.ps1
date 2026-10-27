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
'RUNTIME_RELEASE_HTTP_CHILD_REGRESSION_PASS'
