$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-health-observer.ps1')
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'https://example.com/') { throw 'External health endpoint accepted.' }
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'http://192.0.2.1:1234/') { throw 'Non-loopback health endpoint accepted.' }
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'http://127.0.0.1:1/' -TimeoutMs 1000) { throw 'Unreachable health endpoint accepted.' }
# Regression-owned HTTP listener: a real 200 response, then an unavailable endpoint.
$listener = $null
$job = $null
try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $listener = $null
    $endpoint = [uri]("http://127.0.0.1:$port/health")
    $job = Start-Job -ArgumentList $port -ScriptBlock {
        param($port)
        $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$port)
        try {
            $tcp.Start()
            $client = $tcp.AcceptTcpClient()
            try {
                $stream = $client.GetStream()
                $payload = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Length: 7`r`nConnection: close`r`n`r`nhealthy")
                $stream.Write($payload,0,$payload.Length)
                $stream.Flush()
            } finally { $client.Close() }
        } finally { $tcp.Stop() }
    }
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000) {
            $healthy = $true
            break
        }
        if ($job.State -in @('Failed','Stopped','Completed')) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $healthy) { throw 'Regression-owned HTTP 200 health response was rejected.' }
    $null = Wait-Job -Job $job -Timeout 5
    if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000) {
        throw 'Stopped regression HTTP endpoint was accepted.'
    }
} finally {
    if ($null -ne $job) {
        if ($job.State -eq 'Running') { Stop-Job -Job $job }
        Remove-Job -Job $job -Force
    }
    if ($null -ne $listener) { $listener.Stop() }
}
# Wire the real HTTP probe into the durable isolated transaction executor.
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-isolated-executor.ps1')
$directory = Join-Path $env:TEMP ('release-http-rollback-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
    $initial = [pscustomobject]@{ transaction_id='http-rollback'; broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
    $check = { param($snapshot) Test-RuntimeReleaseIsolatedHttpHealth -Uri $endpoint -TimeoutMs 1000 }.GetNewClosure()
    $result = Invoke-RuntimeReleaseIsolatedExecutor -Directory $directory -InitialSnapshot $initial -CheckHealth $check
    if ($result.snapshot.status -cne 'ROLLED_BACK' -or $result.replayed_events -ne 7) {
        throw 'Unavailable real HTTP health endpoint did not trigger durable rollback.'
    }
} finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
'RUNTIME_RELEASE_HEALTH_OBSERVER_REGRESSION_PASS'
