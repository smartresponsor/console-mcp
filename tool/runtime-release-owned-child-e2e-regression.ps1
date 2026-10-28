$ErrorActionPreference = 'Stop'
foreach ($name in @('87-release-states','88-release-event-reducer','88-release-replay','88-release-durable-events','88-release-isolated-executor','88-release-process-observer','88-release-health-observer','88-release-isolated-child-owner')) { . (Join-Path $PSScriptRoot ('dev-console.d/' + $name + '.ps1')) }
$owner=New-RuntimeReleaseIsolatedChildOwner -FixturePath (Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1')
foreach ($failure in @('none','health-failed')) {
    $holder=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
    $holder.Start(); $port=([System.Net.IPEndPoint]$holder.LocalEndpoint).Port; $holder.Stop()
    $uri=[uri]("http://127.0.0.1:$port/health")
    $dir=Join-Path $env:TEMP ('owned-release-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $f=[pscustomobject]@{ Old=$null; New=$null; Restored=$null }
    try {
        $f.Old=Start-RuntimeReleaseOwnedChild -Owner $owner -Port $port
        $initial=[pscustomobject]@{ transaction_id=('owned-'+$failure); broker_generation='broker'; login_epoch='epoch'; status='PREPARED'; sequence=[long]0 }
        $observer={
            param($snapshot,$state)
            switch ($state) {
                'SWITCH_REQUESTED' { return (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.Old) }
                'STOP_CONFIRMED' { return (Stop-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.Old) }
                'START_REQUESTED' { $f.New=Start-RuntimeReleaseOwnedChild -Owner $owner -Port $port; return (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New) }
                'HEALTH_VERIFYING' { return (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New) }
                'COMMITTED' { return ((Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New) -and (Test-RuntimeReleaseIsolatedHttpHealth -Uri $uri -TimeoutMs 1000)) }
                'ROLLBACK_REQUESTED' { return (Stop-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New) }
                'OLD_RUNTIME_RESTORED' { $f.Restored=Start-RuntimeReleaseOwnedChild -Owner $owner -Port $port; return (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.Restored) }
                'ROLLED_BACK' { return ((Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.Restored) -and (-not (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New))) }
                default { return $false }
            }
        }.GetNewClosure()
        $health={
            param($snapshot)
            if ($failure -eq 'health-failed') { return $false }
            for ($i=0;$i -lt 30;$i++) {
                if (-not (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New)) { return $false }
                if (Test-RuntimeReleaseIsolatedHttpHealth -Uri $uri -TimeoutMs 1000) { return $true }
                Start-Sleep -Milliseconds 100
            }
            return $false
        }.GetNewClosure()
        $result=Invoke-RuntimeReleaseIsolatedExecutor -Directory $dir -InitialSnapshot $initial -RequireObservation -ObserveTransition $observer -RequireHealthCheck -CheckHealth $health
        $expected=if ($failure -eq 'none') {'COMMITTED'} else {'ROLLED_BACK'}
        if ($result.snapshot.status -cne $expected) { throw ('Owned executor result mismatch: '+$failure) }
        if ($failure -eq 'none' -and -not (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.New)) { throw 'Committed child absent' }
        if ($failure -eq 'health-failed' -and -not (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $f.Restored)) { throw 'Restored child absent' }
    } finally {
        foreach ($child in @($f.Old,$f.New,$f.Restored)) {
            if ($null -ne $child -and (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $child)) { $null=Stop-RuntimeReleaseOwnedChild -Owner $owner -Identity $child }
        }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
'RUNTIME_RELEASE_OWNED_CHILD_E2E_PASS'
