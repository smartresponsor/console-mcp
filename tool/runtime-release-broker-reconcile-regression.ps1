$ErrorActionPreference='Stop'
foreach ($name in @('88-release-process-observer','88-release-health-observer','88-release-broker-controller','88-release-broker-reconcile')) { . (Join-Path $PSScriptRoot ('dev-console.d/' + $name + '.ps1')) }
$exe=[string](Get-Process -Id $PID).Path
$fixture=Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1'
$holder=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$holder.Start(); $port=([System.Net.IPEndPoint]$holder.LocalEndpoint).Port; $holder.Stop()
$uri=[uri]("http://127.0.0.1:$port/health")
$old=$null; $new=$null
try {
    $old=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
    $oldCreated=[datetimeoffset]$old.StartTime.ToUniversalTime()
    $new=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$fixture+'"'),'-Port',$port) -PassThru -WindowStyle Hidden
    $newCreated=[datetimeoffset]$new.StartTime.ToUniversalTime()
    $controller=New-RuntimeReleaseBrokerController -Generation 'generation' -LoginEpoch 'epoch' -SessionId 1
    Enter-RuntimeReleaseBrokerTransaction -Controller $controller -TransactionId 'tx' -ExpectedGeneration 'generation' -ExpectedLoginEpoch 'epoch' -ExpectedSessionId 1
    Set-RuntimeReleaseBrokerRecoveryRequired -Controller $controller -TransactionId 'tx'
    $snapshot=[pscustomobject]@{transaction_id='tx';status='HEALTH_VERIFYING'}
    $args=@{Controller=$controller;Snapshot=$snapshot;OldProcessId=$old.Id;OldCreatedAt=$oldCreated;OldExecutable=$exe;ReplacementProcessId=$new.Id;ReplacementCreatedAt=$newCreated;ReplacementExecutable=$exe;HealthUri=$uri}
    $both=Get-RuntimeReleaseBrokerRuntimeReconciliation @args
    if ($both.classification -cne 'BOTH_RUNNING' -or $both.mutation_authorized -or $both.automatic_commit_allowed) { throw 'Concurrent runtimes not classified safely.' }
    $old.Kill(); $null=$old.WaitForExit(10000)
    $healthy=$false
    for ($i=0;$i -lt 30;$i++) { $result=Get-RuntimeReleaseBrokerRuntimeReconciliation @args; if ($result.classification -ceq 'REPLACEMENT_HEALTHY') { $healthy=$true;break }; Start-Sleep -Milliseconds 100 }
    if (-not $healthy -or $result.automatic_commit_allowed) { throw 'Replacement reconciliation failed or committed automatically.' }
    $new.Kill(); $null=$new.WaitForExit(10000)
    $neither=Get-RuntimeReleaseBrokerRuntimeReconciliation @args
    if ($neither.classification -cne 'NEITHER_RUNNING') { throw 'Stopped runtimes not classified.' }
} finally {
    foreach ($child in @($old,$new)) { if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(10000) } }
}
'RUNTIME_RELEASE_BROKER_RECONCILE_REGRESSION_PASS'
