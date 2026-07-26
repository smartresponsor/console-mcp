function Start-WatchdogLoop {
    Ensure-Directories
    $state = Get-WatchdogLoopProcessState
    if ($state.running) {
        $heartbeat = Get-WatchdogLoopHeartbeatState -Loop $state
        if ($heartbeat.ok) {
            $state | Add-Member -NotePropertyName heartbeat -NotePropertyValue $heartbeat -Force
            return ($state | ConvertTo-Json -Depth 20)
        }
        # The PID file and Task Scheduler both consider this "running" - the process exists - but
        # its own heartbeat (written once/sec by watchdog-loop-run) is stale, missing, or belongs to
        # a different generation. That is a hung/zombie loop, not a healthy one: trusting bare
        # process-liveness here is exactly the false "job completed" signal that let a hung loop
        # survive indefinitely, including across every future 5-minute safety-net trigger. Stop it
        # and fall through to a genuine relaunch instead.
        Stop-WatchdogLoop | Out-Null
        $state = Get-WatchdogLoopProcessState
    }

    Remove-Item -LiteralPath $WatchdogLoopPidFile -Force -ErrorAction SilentlyContinue

    # If THIS process is already running in the interactive desktop session, a direct launch is
    # already session-safe by construction - no relay needed. This matters for two real cases, not
    # just "saves a hop": (1) testing/operating locally, where routing through the task anyway just
    # adds latency and risk for zero benefit; (2) the scheduled task's OWN action invoking
    # 'start-watchdog-loop' recursively hits this same function while Task Scheduler still
    # considers the task "Running" - a nested Start-ScheduledTask call in that state is silently
    # ignored (MultipleInstances=IgnoreNew), which previously made the outer caller wait out the
    # full poll window and report a misleading 'fallback' even though everything was actually fine
    # (the task's own process IS already correctly sessioned). Checking session identity up front
    # avoids both the wasted round-trip and the confusing false-fallback report.
    $ownSessionId = $null
    try { $ownSessionId = (Get-Process -Id $PID).SessionId } catch { $ownSessionId = $null }
    $consoleSession = Get-ConsoleSessionReport
    $alreadyInteractiveSession = [bool]($consoleSession.active_console -and $ownSessionId -ne $null -and [int]$consoleSession.active_console.id -eq [int]$ownSessionId)

    if ($alreadyInteractiveSession) {
        $pwshDirectPath = Resolve-WatchdogPwshPath
        $scriptPathDirect = Join-Path $Root 'tool\dev-console.ps1'
        $processDirect = Start-Process `
            -FilePath $pwshDirectPath `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPathDirect, 'watchdog-loop-run') `
            -WorkingDirectory $Root `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput ($WatchdogLoopLogFile + '.stdout.log') `
            -RedirectStandardError ($WatchdogLoopLogFile + '.stderr.log')
        Set-Content -LiteralPath $WatchdogLoopPidFile -Value $processDirect.Id -NoNewline
        $directDeadline = (Get-Date).AddSeconds(15)
        $resultDirect = Get-WatchdogLoopProcessState
        $directHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $resultDirect
        while ((Get-Date) -lt $directDeadline -and -not ($resultDirect.running -and $directHeartbeat.ok)) {
            Start-Sleep -Milliseconds 500
            $resultDirect = Get-WatchdogLoopProcessState
            $directHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $resultDirect
        }
        $resultDirect | Add-Member -NotePropertyName launch_path -NotePropertyValue 'direct_already_correct_session' -Force
        $resultDirect | Add-Member -NotePropertyName own_session_id -NotePropertyValue $ownSessionId -Force
        $resultDirect | Add-Member -NotePropertyName heartbeat -NotePropertyValue $directHeartbeat -Force
        if (-not ($resultDirect.running -and $directHeartbeat.ok)) {
            $resultDirect | Add-Member -NotePropertyName failure_classification -NotePropertyValue (Get-WatchdogLaunchFailureClassification -ConsoleSession $consoleSession -Loop $resultDirect -Heartbeat $directHeartbeat) -Force
        }
        return ($resultDirect | ConvertTo-Json -Depth 20)
    }

    $task = $null
    try {
        Import-Module ScheduledTasks -ErrorAction Stop
        $task = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    } catch {
        $task = $null
    }

    $autoInstallAttempted = $false
    $autoInstallSucceeded = $false
    if (-not $task) {
        $autoInstallAttempted = $true
        try {
            Install-WatchdogTask | Out-Null
            $task = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
            $autoInstallSucceeded = [bool]$task
        } catch {
            $task = $null
            $autoInstallSucceeded = $false
        }
    }

    $launchedViaTask = $false
    if ($task) {
        try {
            $launcherPathForStart = Join-Path $RunDir 'watchdog-task-bootstrap.ps1'
            $launcherInfoForStart = Get-Item -LiteralPath $launcherPathForStart -ErrorAction Stop
            $launcherAppliedAt = $launcherInfoForStart.LastWriteTime
            Start-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction Stop
            $taskRunDeadline = (Get-Date).AddSeconds(15)
            $taskRunInfo = $null
            do {
                Start-Sleep -Milliseconds 250
                $taskRunInfo = Get-ScheduledTaskInfo -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
            } while (($null -eq $taskRunInfo -or $taskRunInfo.LastRunTime -lt $launcherAppliedAt) -and (Get-Date) -lt $taskRunDeadline)
            if ($null -eq $taskRunInfo -or $taskRunInfo.LastRunTime -lt $launcherAppliedAt) {
                return [pscustomobject]@{
                    ok = $false
                    status = 'WATCHDOG_LAUNCHER_NOT_APPLIED'
                    runtime_mutated = $false
                    launcher_last_write_time = $launcherAppliedAt.ToString('o')
                    task_last_run_time = if ($taskRunInfo) { $taskRunInfo.LastRunTime.ToString('o') } else { $null }
                }
            }
            $launchedViaTask = $true
        } catch {
            $launchedViaTask = $false
        }
    }

    if ($launchedViaTask) {
        $deadline = (Get-Date).AddSeconds(45)
        $polled = Get-WatchdogLoopProcessState
        $polledHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $polled
        while ((Get-Date) -lt $deadline -and -not ($polled.running -and $polledHeartbeat.ok)) {
            Start-Sleep -Milliseconds 500
            $polled = Get-WatchdogLoopProcessState
            $polledHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $polled
        }
        if ($polled.running -and $polledHeartbeat.ok) {
            $polled | Add-Member -NotePropertyName launch_path -NotePropertyValue 'scheduled_task' -Force
            $polled | Add-Member -NotePropertyName auto_installed_task -NotePropertyValue $autoInstallSucceeded -Force
            $polled | Add-Member -NotePropertyName heartbeat -NotePropertyValue $polledHeartbeat -Force
            return ($polled | ConvertTo-Json -Depth 20)
        }
    }

    $finalLoopState = Get-WatchdogLoopProcessState
    $finalHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $finalLoopState
    $classification = Get-WatchdogLaunchFailureClassification -ConsoleSession $consoleSession -Loop $finalLoopState -Heartbeat $finalHeartbeat
    return ([pscustomobject]@{
        ok = $false
        status = 'INTERACTIVE_EXECUTOR_UNAVAILABLE'
        launch_path = 'fail_closed'
        auto_install_attempted = $autoInstallAttempted
        auto_install_succeeded = $autoInstallSucceeded
        own_session_id = $ownSessionId
        active_console_session_id = if ($consoleSession.active_console) { $consoleSession.active_console.id } else { $null }
        reason = 'scheduled_task_did_not_produce_interactive_watchdog_loop'
        failure_classification = $classification
        next_action = 'repair the interactive Scheduled Task or console login; never launch the watchdog from SSH with Start-Process'
    } | ConvertTo-Json -Depth 20)
}

function Stop-WatchdogLoop {
    $state = Get-WatchdogLoopProcessState
    $stopDetail = [ordered]@{
        requested_by = 'dev-console'
        pid = $state.pid
        running_before_stop = [bool]$state.running
        stop_attempted = $false
        stop_error = $null
        extra_instances_killed = @()
        task_stopped = $false
    }

    if ($state.pid) {
        $stopDetail.stop_attempted = $true
        try {
            Stop-Process -Id ([int]$state.pid) -Force -ErrorAction Stop
        } catch {
            if (Test-ManagedPid -ProcessId ([int]$state.pid)) {
                $stopDetail.stop_error = Sanitize-Text $_.Exception.Message
            }
        }

        foreach ($attempt in 1..20) {
            if (-not (Test-ManagedPid -ProcessId ([int]$state.pid))) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }

    $survivors = @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'watchdog-loop-run' -and [int]$_.ProcessId -ne [int]$state.pid })
    foreach ($survivor in $survivors) {
        try {
            Stop-Process -Id ([int]$survivor.ProcessId) -Force -ErrorAction Stop
            $stopDetail.extra_instances_killed += [int]$survivor.ProcessId
        } catch { }
    }

    try {
        Import-Module ScheduledTasks -ErrorAction Stop
        if (Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
            $stopDetail.task_stopped = $true
        }
    } catch { }

    $stopDetail.running_after_stop = if ($state.pid) { Test-ManagedPid -ProcessId ([int]$state.pid) } else { $false }
    Remove-Item -LiteralPath $WatchdogLoopPidFile -Force -ErrorAction SilentlyContinue
    Write-WatchdogLoopState -Status 'STOPPED' -Ok (-not $stopDetail.running_after_stop) -Detail ([pscustomobject]$stopDetail) | Out-Null
    return (Get-WatchdogLoopProcessState | ConvertTo-Json -Depth 20)
}

function Restart-WatchdogLoop {
    Stop-WatchdogLoop | Out-Null
    return Start-WatchdogLoop
}

