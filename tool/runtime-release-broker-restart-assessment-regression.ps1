$ErrorActionPreference='Stop'
foreach ($name in @('87-release-states','88-release-event-reducer','88-release-replay','88-release-durable-events','88-release-isolated-executor','88-release-process-observer','88-release-health-observer','88-release-broker-controller','88-release-broker-recovery','88-release-broker-reconcile','88-release-broker-restart-assessment','88-release-journal-correlation')) { . (Join-Path $PSScriptRoot ('dev-console.d/' + $name + '.ps1')) }
$exe=[string](Get-Process -Id $PID).Path
$fixture=Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1'
foreach ($cut in @(2,4,5)) {
    $holder=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
    $holder.Start(); $port=([System.Net.IPEndPoint]$holder.LocalEndpoint).Port; $holder.Stop()
    $uri=[uri]("http://127.0.0.1:$port/health")
    $dir=Join-Path $env:TEMP ('release-restart-assessment-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $old=$null; $replacement=$null
    try {
        $old=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
        $oldCreated=[datetimeoffset]$old.StartTime.ToUniversalTime()
        $replacement=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$fixture+'"'),'-Port',$port) -PassThru -WindowStyle Hidden
        $replacementCreated=[datetimeoffset]$replacement.StartTime.ToUniversalTime()
        $initial=[pscustomobject]@{transaction_id='tx';broker_generation='generation-1';login_epoch='epoch';status='PREPARED';sequence=[long]0}
        $interrupted=$false
        try { $null=Invoke-RuntimeReleaseIsolatedExecutor -Directory $dir -InitialSnapshot $initial -InterruptAfterEvents $cut } catch { if ($_.Exception.Message -eq 'INJECTED_RELEASE_EXECUTOR_INTERRUPTION') { $interrupted=$true } else { throw } }
        if (-not $interrupted) { throw 'Durable interruption not injected.' }
        $journalRoot=$dir + '-prepared-journal'
        New-Item -ItemType Directory -Path $journalRoot -ErrorAction Stop | Out-Null
        $transactionId=[guid]::NewGuid().ToString('N')
        $prepared=[pscustomobject]@{ transaction_id=$transactionId;status='PREPARED';commit_enabled=$false;runtime_mutated=$false;expected_broker_generation='generation-1';expected_login_epoch='epoch' }
        $prepared | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $journalRoot ($transactionId+'.json'))
        $eventStream=Join-Path $journalRoot ($transactionId+'.events')
        New-Item -ItemType Directory -Path $eventStream -ErrorAction Stop | Out-Null
        Get-ChildItem -LiteralPath $dir -File -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $eventStream -ErrorAction Stop }
        $correlation=Get-RuntimeReleaseJournalCorrelation -Directory $journalRoot
        if ($correlation.reason -cne 'EVENT_STREAM_IDENTITY_MISMATCH' -or $correlation.mutation_authorized) { throw 'Mismatched interrupted stream was accepted' }
        if ($cut -eq 2) { $replacement.Kill(); $null=$replacement.WaitForExit(10000) } else { $old.Kill(); $null=$old.WaitForExit(10000) }
        $controller=New-RuntimeReleaseBrokerController -Generation 'generation-2' -LoginEpoch 'epoch' -SessionId 1
        $args=@{Controller=$controller;Directory=$dir;InitialSnapshot=$initial;OldProcessId=$old.Id;OldCreatedAt=$oldCreated;OldExecutable=$exe;ReplacementProcessId=$replacement.Id;ReplacementCreatedAt=$replacementCreated;ReplacementExecutable=$exe;HealthUri=$uri}
        $assessment=Get-RuntimeReleaseBrokerRestartAssessment @args
        $expected=if ($cut -eq 2) {'OLD_RUNTIME_ONLY'} else {'REPLACEMENT_HEALTHY'}
        if ($cut -ne 2) {
            for ($i=0;$i -lt 30 -and $assessment.runtime_classification -cne 'REPLACEMENT_HEALTHY';$i++) {
                # A new controller models a separate broker restart; no reuse of initialized state.
                $controller=New-RuntimeReleaseBrokerController -Generation 'generation-2' -LoginEpoch 'epoch' -SessionId 1
                $args.Controller=$controller
                Start-Sleep -Milliseconds 100
                $assessment=Get-RuntimeReleaseBrokerRestartAssessment @args
            }
        }
        if ($assessment.runtime_classification -cne $expected -or $assessment.journal_reason -cne 'BROKER_IDENTITY_CHANGED' -or $assessment.status -cne 'RECOVERY_REQUIRED' -or $assessment.automatic_commit_allowed -or $assessment.automatic_replay_allowed -or $assessment.mutation_authorized) { throw ('Unsafe restart assessment at event '+$cut) }
        if (Test-RuntimeReleaseBrokerAdmission -Controller $controller -TransactionId 'tx' -ExpectedGeneration 'generation-2' -ExpectedLoginEpoch 'epoch' -ExpectedSessionId 1) { throw 'Restart admitted duplicate transaction.' }
    } finally {
        foreach ($child in @($old,$replacement)) { if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(10000) } }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        if ($journalRoot) { Remove-Item -LiteralPath $journalRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
'RUNTIME_RELEASE_BROKER_RESTART_ASSESSMENT_REGRESSION_PASS'
