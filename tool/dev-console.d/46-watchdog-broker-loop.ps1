function Invoke-WatchdogLoopRun {
    Ensure-Directories
    Initialize-ServerControlQueue
    Set-Content -LiteralPath $WatchdogLoopPidFile -Value $PID -NoNewline
    $broker = New-ServerControlBrokerIdentity
    Write-ServerControlBrokerIdentity -Identity $broker
    Write-WatchdogLoopState -Status 'STARTED' -Ok $true -Detail @{ mode = 'interactive-control-broker'; generation = $broker.generation; cadence = Get-WatchdogCadenceDefinition } | Out-Null
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
}

