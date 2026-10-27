$ErrorActionPreference='Stop'
foreach ($name in @('87-release-states','88-release-event-reducer','88-release-replay','88-release-durable-events','88-release-isolated-executor','88-release-broker-controller','88-release-broker-recovery')) { . (Join-Path $PSScriptRoot ('dev-console.d/' + $name + '.ps1')) }
foreach ($cut in 1..5) {
    $dir = Join-Path $env:TEMP ('release-broker-restart-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    try {
        $initial = [pscustomobject]@{ transaction_id='restart-test'; broker_generation='generation-1'; login_epoch='epoch-1'; status='PREPARED'; sequence=[long]0 }
        $interrupted=$false
        try { $null=Invoke-RuntimeReleaseIsolatedExecutor -Directory $dir -InitialSnapshot $initial -InterruptAfterEvents $cut } catch { if ($_.Exception.Message -eq 'INJECTED_RELEASE_EXECUTOR_INTERRUPTION') { $interrupted=$true } else { throw } }
        if (-not $interrupted) { throw 'Interruption not injected.' }
        foreach ($generation in @('generation-1','generation-2')) {
            $c=New-RuntimeReleaseBrokerController -Generation $generation -LoginEpoch 'epoch-1' -SessionId 1
            $recovered=Initialize-RuntimeReleaseBrokerFromDurableJournal -Controller $c -Directory $dir -InitialSnapshot $initial
            if ($c.state -cne 'RECOVERY_REQUIRED' -or $recovered.status -cne 'RECOVERY_REQUIRED' -or (Test-RuntimeReleaseBrokerAdmission -Controller $c -TransactionId 'restart-test' -ExpectedGeneration $generation -ExpectedLoginEpoch 'epoch-1' -ExpectedSessionId 1)) { throw 'Restart allowed automatic replay.' }
            if ($generation -eq 'generation-2' -and $recovered.reason -cne 'BROKER_IDENTITY_CHANGED') { throw 'Changed generation not detected.' }
        }
    } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}
'RUNTIME_RELEASE_BROKER_RECOVERY_REGRESSION_PASS'
