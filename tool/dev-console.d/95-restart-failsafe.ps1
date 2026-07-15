# Fail-safe public runtime restart transaction.
$RestartPreflightReceiptFile = Join-Path $RunDir 'console-mcp-restart-preflight-receipt.json'

function Get-RestartControlPlaneEvidence {
    $previousWarningPreference = $WarningPreference
    try {
        $WarningPreference = 'SilentlyContinue'
        $task = Show-WatchdogTask | ConvertFrom-Json -Depth 20
    } catch {
        $task = $null
    } finally {
        $WarningPreference = $previousWarningPreference
    }
    $launcherPath = Join-Path $RunDir 'watchdog-task-bootstrap.ps1'
    $launcherExists = Test-Path -LiteralPath $launcherPath -PathType Leaf
    $launcherCurrent = $false
    if ($launcherExists) {
        $launcher = Get-Content -LiteralPath $launcherPath -Raw
        $launcherCurrent = $launcher -match [regex]::Escape((Join-Path $Root 'tool\dev-console.ps1')) -and $launcher -match 'watchdog-loop-run' -and $launcher -match 'session_id'
    }

    $console = Get-ConsoleSessionReport
    $loop = Get-WatchdogLoopProcessState
    $heartbeat = Get-WatchdogLoopHeartbeatState -Loop $loop
    $instanceCount = Get-ConsoleWatchdogLoopInstanceCount
    $broker = Get-ServerControlBrokerIdentity
    $supportedActions = if ($broker -and $broker.supported_actions) { @($broker.supported_actions) } else { @('stop-server') }
    $taskReady = [bool]($task -and $task.exists -and $task.declaration -and $task.declaration.ok)
    $brokerPidMatches = [bool]($broker -and $loop.pid -and [int]$broker.pid -eq [int]$loop.pid)
    $brokerSessionMatches = [bool]($broker -and $console.active_console -and [int]$broker.windows_session_id -eq [int]$console.active_console.id)
    $ok = [bool](
        $taskReady -and
        $launcherCurrent -and
        $console.ok -and
        $loop.running -and
        $heartbeat.ok -and
        $instanceCount -eq 1 -and
        $brokerPidMatches -and
        $brokerSessionMatches -and
        ($supportedActions -contains 'stop-server')
    )

    return [pscustomobject]@{
        ok = $ok
        task = $task
        launcher_exists = $launcherExists
        launcher_current = $launcherCurrent
        console = $console
        loop = $loop
        heartbeat = $heartbeat
        instance_count = $instanceCount
        single_instance = [bool]($instanceCount -eq 1)
        broker = $broker
        broker_pid_matches = $brokerPidMatches
        broker_session_matches = $brokerSessionMatches
        supported_actions = $supportedActions
    }
}

function Invoke-RestartWatchdogBootstrapRepair {
    $before = Get-RestartControlPlaneEvidence
    try {
        Install-WatchdogTask | Out-Null
        if ($before.instance_count -gt 1 -or ($before.loop.running -and -not $before.heartbeat.ok)) {
            Stop-WatchdogLoop | Out-Null
        }
        Import-Module ScheduledTasks -ErrorAction Stop
        Start-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 500
            $after = Get-RestartControlPlaneEvidence
        } while ((Get-Date) -lt $deadline -and -not $after.ok)

        if (-not $after.ok) {
            return [pscustomobject]@{ ok = $false; status = 'WATCHDOG_BOOTSTRAP_FAILED'; runtime_mutated = $false; before = $before; after = $after }
        }
        return [pscustomobject]@{ ok = $true; status = 'WATCHDOG_BOOTSTRAP_REPAIRED'; runtime_mutated = $false; before = $before; after = $after }
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'WATCHDOG_BOOTSTRAP_FAILED'; runtime_mutated = $false; before = $before; error = Sanitize-Text $_.Exception.Message }
    }
}

function Get-RestartRuntimeEvidence {
    $ports = Get-ConsoleServerPorts
    $listeners = Get-ConsoleServerListenerRecords
    $confirmed = @(Get-ConsoleServerAuthoritativeInventory | Where-Object { $_.identity_confirmed })
    $runtimePids = @($confirmed | ForEach-Object { [int]$_.pid } | Sort-Object -Unique)
    $portsOwnedByExpectedPid = $true
    foreach ($port in $ports) {
        $listener = @($listeners | Where-Object { [int]$_.port -eq [int]$port } | Select-Object -First 1)
        if ($listener.Count -eq 0 -or $runtimePids -notcontains [int]$listener[0].pid) {
            $portsOwnedByExpectedPid = $false
        }
    }

    $build = Get-BuildOutputReport
    $secret = Get-ConsoleBearerTokenStatus
    $running = [bool]($runtimePids.Count -eq 1 -and $portsOwnedByExpectedPid)
    $replacementReady = [bool]($build.build_current -and $secret.ok)
    return [pscustomobject]@{
        ok = [bool]($running -and $replacementReady)
        running = $running
        pid = if ($runtimePids.Count -eq 1) { $runtimePids[0] } else { $null }
        ports = $ports
        ports_owned_by_expected_pid = $portsOwnedByExpectedPid
        replacement_ready = $replacementReady
        build = $build
        secret = $secret
    }
}

function New-RestartReceipt {
    param($Control, $Runtime)
    $now = (Get-Date).ToUniversalTime()
    $payload = [ordered]@{
        schema_version = 1
        issued_at = $now.ToString('o')
        expires_at = $now.AddSeconds(60).ToString('o')
        broker_generation = [string]$Control.broker.generation
        runtime_pid = [int]$Runtime.pid
    }
    $payload.receipt_hash = Get-TextSha256 -Text ($payload | ConvertTo-Json -Compress)
    $receipt = [pscustomobject]$payload
    Write-ServerControlJsonAtomically -Path $RestartPreflightReceiptFile -Value $receipt
    return $receipt
}

function Test-RestartReceipt {
    param($Receipt, $Control, $Runtime)
    if (-not $Receipt) { return $false }
    try { $expiresAt = [datetime]::Parse([string]$Receipt.expires_at).ToUniversalTime() } catch { return $false }
    $payload = [ordered]@{
        schema_version = [int]$Receipt.schema_version
        issued_at = [string]$Receipt.issued_at
        expires_at = [string]$Receipt.expires_at
        broker_generation = [string]$Receipt.broker_generation
        runtime_pid = [int]$Receipt.runtime_pid
    }
    $expectedHash = Get-TextSha256 -Text ($payload | ConvertTo-Json -Compress)
    return [bool](
        $expiresAt -gt (Get-Date).ToUniversalTime() -and
        $expectedHash -eq [string]$Receipt.receipt_hash -and
        [string]$Receipt.broker_generation -eq [string]$Control.broker.generation -and
        [int]$Receipt.runtime_pid -eq [int]$Runtime.pid
    )
}

function Invoke-RestartPreflight {
    param([switch]$AllowRepair, [switch]$Diagnostic)
    $control = Get-RestartControlPlaneEvidence
    $repair = $null
    if (-not $control.ok -and $AllowRepair) {
        $repair = Invoke-RestartWatchdogBootstrapRepair
        if (-not $repair.ok) { return $repair }
        $control = $repair.after
    }

    $runtime = Get-RestartRuntimeEvidence
    $ok = [bool]($control.ok -and $runtime.ok)
    $receipt = if ($ok) { New-RestartReceipt -Control $control -Runtime $runtime } else { $null }
    $result = [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'RESTART_PREFLIGHT_READY' } else { 'RESTART_PREFLIGHT_BLOCKED' }
        runtime_mutated = $false
        watchdog = [pscustomobject]@{ running = $control.loop.running; heartbeat_fresh = $control.heartbeat.ok; single_instance = $control.single_instance; pid = $control.loop.pid }
        runtime = [pscustomobject]@{ running = $runtime.running; pid = $runtime.pid; replacement_ready = $runtime.replacement_ready }
        broker_generation = if ($control.broker) { $control.broker.generation } else { $null }
        receipt = $receipt
        repair = $repair
    }
    if ($Diagnostic) {
        $result | Add-Member -NotePropertyName diagnostic -NotePropertyValue ([pscustomobject]@{ control = $control; runtime = $runtime }) -Force
    }
    return $result
}

function Wait-RestartSchemaConfirmation {
    param([int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $state = Get-ChatgptConnectorRefreshState
        if ($state -and (Test-ChatgptConnectorRefreshAcceptable -Result $state)) {
            return [pscustomobject]@{ ok = $true; status = 'SCHEMA_CONFIRMED'; state = $state }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ ok = $false; status = 'SCHEMA_PENDING'; state = $state }
}

function ConvertTo-RestartCompactResult {
    param($Result)
    return [pscustomobject]@{
        ok = [bool]$Result.ok
        status = [string]$Result.status
        runtime_mutated = [bool]$Result.runtime_mutated
        old_pid = $Result.old_pid
        new_pid = $Result.new_pid
        watchdog_pid = $Result.watchdog_pid
        broker_generation = $Result.broker_generation
        ports_healthy = [bool]$Result.ports_healthy
        schema_confirmed = [bool]$Result.schema_confirmed
    }
}

function Invoke-FailSafeRestart {
    param([switch]$Diagnostic)
    $prepare = Invoke-RestartPreflight -AllowRepair -Diagnostic:$Diagnostic
    if (-not $prepare.ok) { return $prepare }

    $control = Get-RestartControlPlaneEvidence
    $runtime = Get-RestartRuntimeEvidence
    if (-not (Test-RestartReceipt -Receipt $prepare.receipt -Control $control -Runtime $runtime)) {
        return [pscustomobject]@{ ok = $false; status = 'RESTART_RECEIPT_INVALID'; runtime_mutated = $false }
    }
    if (-not ($control.supported_actions -contains 'stop-server')) {
        return [pscustomobject]@{ ok = $false; status = 'BROKER_CAPABILITY_MISSING'; runtime_mutated = $false }
    }

    $oldPid = [int]$runtime.pid
    $response = Request-ServerControlAction -Action 'stop-server'
    $newRuntime = Get-RestartRuntimeEvidence
    # Runtime replacement success is established by authoritative process/port evidence.
    # Broker-level ok may remain false while connector schema propagation is still pending;
    # that must not trigger an unnecessary rollback of an otherwise healthy replacement.
    $replacementOk = [bool]($newRuntime.running -and [int]$newRuntime.pid -ne $oldPid)
    if (-not $replacementOk) {
        try {
            Start-UnifiedConsoleRuntime | Out-Null
            $rollbackReady = Wait-ConsoleServerReplacementReady -OldPids @($oldPid) -TimeoutSeconds 90
        } catch {
            $rollbackReady = $null
        }
        $newRuntime = Get-RestartRuntimeEvidence
        $failed = [pscustomobject]@{
            ok = $false
            status = if ($rollbackReady -and $rollbackReady.ok) { 'RESTART_FAILED_RUNTIME_RECOVERED' } else { 'RESTART_FAILED_RUNTIME_UNAVAILABLE' }
            runtime_mutated = $true
            old_pid = $oldPid
            new_pid = $newRuntime.pid
            watchdog_pid = $control.loop.pid
            broker_generation = $control.broker.generation
            ports_healthy = $newRuntime.running
            schema_confirmed = $false
            response = $response
        }
        return $(if ($Diagnostic) { $failed } else { ConvertTo-RestartCompactResult -Result $failed })
    }

    $schemaWait = if ([bool]$response.result.schema_propagation_confirmed) { [pscustomobject]@{ ok = $true; status = 'SCHEMA_CONFIRMED'; state = $null } } else { Wait-RestartSchemaConfirmation -TimeoutSeconds 20 }
    $schemaConfirmed = [bool]$schemaWait.ok
    $completed = [pscustomobject]@{
        ok = $true
        status = if ($schemaConfirmed) { [string]$response.result.status } else { 'RESTART_COMPLETED_SCHEMA_PENDING' }
        runtime_mutated = $true
        old_pid = $oldPid
        new_pid = $newRuntime.pid
        watchdog_pid = $control.loop.pid
        broker_generation = $control.broker.generation
        ports_healthy = $newRuntime.running
        schema_confirmed = $schemaConfirmed
        prepare = $prepare
        response = $response
    }
    return $(if ($Diagnostic) { $completed } else { ConvertTo-RestartCompactResult -Result $completed })
}
