function Invoke-WatchdogLoopRun {
    Ensure-Directories
    $ownerLockPath = Join-Path $RunDir 'console-mcp-watchdog-loop.owner.lock'
    $ownerLock = $null
    try {
        try {
            $ownerLock = [System.IO.File]::Open(
                $ownerLockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        } catch [System.IO.IOException] {
            Write-WatchdogLoopState -Status 'DUPLICATE_LOOP_REJECTED' -Ok $false -Detail @{ pid = $PID; owner_lock = $ownerLockPath } | Out-Null
            return
        }

        $ownerLock.SetLength(0)
        $ownerBytes = [System.Text.Encoding]::UTF8.GetBytes(([pscustomobject]@{ pid = $PID; acquired_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
        $ownerLock.Write($ownerBytes, 0, $ownerBytes.Length)
        $ownerLock.Flush($true)

        Initialize-ServerControlQueue
        Set-Content -LiteralPath $WatchdogLoopPidFile -Value $PID -NoNewline
        $broker = New-ServerControlBrokerIdentity
        Write-ServerControlBrokerIdentity -Identity $broker
        Write-WatchdogLoopState -Status 'STARTED' -Ok $true -Detail @{ mode = 'interactive-control-broker'; generation = $broker.generation; cadence = Get-WatchdogCadenceDefinition; owner_lock = $ownerLockPath } | Out-Null
        $cadenceState = Get-WatchdogCadenceState

        while ($true) {
            try {
                # The broker lane is intentionally lightweight and runs every second. It owns only
                # heartbeat, queue claim and session-correct command execution.
                $broker = Update-ServerControlBrokerHeartbeat -Identity $broker
                $pendingControl = Invoke-PendingServerControlRequest
                if ($pendingControl) {
                    Write-WatchdogLoopState -Status 'SERVER_CONTROL_HANDLED' -Ok ([bool]$pendingControl.result.ok) -Detail @{ server_control = $pendingControl; broker_generation = $broker.generation } | Out-Null
                }

                # Probe classes are independently scheduled. Healthy slow lanes never block the fast
                # broker path, and the heavyweight repair path is invoked only after a lane proves a
                # fault, with a separate cooldown against repair storms.
                $cadence = Invoke-WatchdogCadenceScheduler -State $cadenceState
                $cadenceState = $cadence.state
                if ($cadence.executed.Count -gt 0 -or $cadence.repair) {
                    Write-WatchdogLoopState -Status $cadence.status -Ok ([bool]$cadence.ok) -Detail @{ executed = $cadence.executed; repair = $cadence.repair; broker_generation = $broker.generation } | Out-Null
                }
            } catch {
                Write-WatchdogLoopState -Status 'HEARTBEAT_FAILED' -Ok $false -ErrorMessage $_.Exception.Message | Out-Null
            }

            Start-Sleep -Seconds 1
        }
    } finally {
        if ($ownerLock) {
            try { $ownerLock.Dispose() } catch { }
        }
    }
}
