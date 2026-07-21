function Invoke-WatchdogHeal {
    $retention = Invoke-VarRetentionIfDue
    $actions = @()
    if ($retention) {
        $actions += [pscustomobject]@{ action = 'var-retention-prune'; reason = 'periodic diagnostic-artifact retention'; results = $retention.results }
    }
    $autologon = Get-AutologonReport
    $consoleSession = Get-ConsoleSessionReport
    if (-not $autologon.ok) {
        $actions += [pscustomobject]@{ action = 'check-autologon'; reason = 'visible browser recovery depends on Windows autologon'; status = $autologon.status; ok = $autologon.ok; reasons = $autologon.reasons }
    }
    if (-not $consoleSession.ok) {
        $actions += [pscustomobject]@{ action = 'check-console-session'; reason = 'visible browser recovery depends on active desktop console session'; status = $consoleSession.status; ok = $consoleSession.ok; reasons = $consoleSession.reasons; active_console = $consoleSession.active_console }
    }
    $chatgptRuntimeRestarted = $false
    $browserRecovery = $null
    $locked = Enter-WatchdogLock
    if (-not $locked) {
        return (Write-WatchdogState -Status 'SKIPPED_LOCKED' -Ok $true -Actions @([pscustomobject]@{ action = 'skip'; reason = 'fresh watchdog lock exists' }) | ConvertTo-Json -Depth 20)
    }

    try {
        $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        if (-not $chatgptState.running -or -not $chatgptState.port_open -or $localChatgpt.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'start-chatgpt-oauth'; reason = 'local chatgpt oauth was not ready' }
            $chatgptRuntimeRestarted = $true
            Start-ChatgptOauth | Out-Null
            Wait-ManagedServiceReady -Spec (Get-ChatgptSpec) -Origin $ChatgptOrigin -Kind 'chatgpt' | Out-Null
        }

        $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $localCodex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        if (-not $codexState.running -or -not $codexState.port_open -or $localCodex.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'replace-unified-runtime'; reason = 'local codex bearer was not ready or token mismatch detected' }
            Stop-UnifiedConsoleRuntime | Out-Null
            Start-CodexBearer | Out-Null
            Wait-ManagedServiceReady -Spec (Get-CodexSpec) -Origin $CodexOrigin -Kind 'codex' -ExpectedTools (Get-DefaultExpectedSurface) | Out-Null
        }

        $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $freshness = Get-ChatgptRuntimeFreshness
        $runtimeReplacePlan = New-ConsoleDevRuntimeReplacePlan
        if ($runtimeReplacePlan.safe_to_execute -eq $true) {
            $actions += [pscustomobject]@{ action = 'runtime-replace-stale'; reason = 'typed runtime replace plan proved chatgpt oauth stale'; freshness = $freshness; runtime_replace_plan = $runtimeReplacePlan }
            $chatgptRuntimeRestarted = $true
            Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools (Get-DefaultExpectedSurface) | Out-Null
            $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
            $freshness = Get-ChatgptRuntimeFreshness
        } elseif ($localChatgpt.ok -eq $true -and $freshness.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'runtime-replace-stale-blocked'; reason = 'typed runtime replace plan did not allow restart'; freshness = $freshness; runtime_replace_plan = $runtimeReplacePlan; ok = $false }
        }

        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            $actions += [pscustomobject]@{ action = 'start-tunnel'; reason = 'cloudflared tunnel was not running' }
            Start-Tunnel | Out-Null
        }

        $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        $mobileEdge = Invoke-MobileEdgeWatchdogHeal
        $actions += [pscustomobject]@{ action = 'mobile-edge-health'; reason = 'Mobiling mobile-edge should be live for mobile app/API work'; status = $mobileEdge.status; ok = $mobileEdge.ok; action_taken = $mobileEdge.action_taken }
        try {
            $browserRecovery = Invoke-BrowserEnsureVisible -Purpose 'watchdog-heal' -PassThroughFailure
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight'; status = $browserRecovery.status; ok = $browserRecovery.ok; recovery_action = $browserRecovery.recovery_action }
        } catch {
            $browserRecovery = [pscustomobject]@{ ok = $false; status = 'BROWSER_RECOVERY_FAILED'; error = Sanitize-Text $_.Exception.Message }
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight failed'; status = $browserRecovery.status; ok = $false; error = $browserRecovery.error }
        }
        if ($public.ok -ne $true -and $localChatgpt.ok -eq $true) {
            $actions += [pscustomobject]@{ action = 'restart-tunnel'; reason = 'public smoke failed while local chatgpt was ready' }
            Stop-Tunnel | Out-Null
            Start-Tunnel | Out-Null
        } elseif ($public.ok -ne $true -and $localChatgpt.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'recover-chatgpt-before-public'; reason = 'both local and public chatgpt smoke failed' }
            Start-ChatgptOauth | Out-Null
            Wait-ManagedServiceReady -Spec (Get-ChatgptSpec) -Origin $ChatgptOrigin -Kind 'chatgpt' | Out-Null
        }

        $finalChatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        $finalChatgptFreshness = Get-ChatgptRuntimeFreshness
        $finalTunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        $finalCodexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $finalLocalChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $finalLocalCodex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        $finalPublic = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        $connectorRefresh = $null
        $browserOk = [bool]($browserRecovery -and $browserRecovery.ok -eq $true)
        $browserSessionBlocked = [bool]($browserRecovery -and $browserRecovery.desktop_boundary -and $browserRecovery.desktop_boundary.blocked -eq $true)
        if ($chatgptRuntimeRestarted -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $finalPublic.ok -eq $true) {
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
            $actions += [pscustomobject]@{ action = 'connector-schema-propagation'; reason = 'runtime was rebuilt/replaced; ChatGPT must refresh and fetch the matching schema'; refresh_status = $connectorRefresh.status; refresh_ok = $connectorRefresh.ok; schema_propagation = $connectorRefresh.schema_propagation }
        }
        $codexOk = [bool]($finalCodexState.running -and $finalCodexState.port_open -and $finalLocalCodex.ok -eq $true)
        # Server recovery (chatgpt/codex/tunnel/public/mobile-edge) is the required, SSH-safe half of
        # watchdog health. Browser-visible recovery is best-effort: when it fails solely because this
        # process is outside the interactive desktop session (SSH/session-0), that is an expected,
        # non-actionable limitation, not a stack failure, so it must not flip the overall status to FAILED.
        $schemaPropagationOk = [bool](-not $chatgptRuntimeRestarted -or (Test-ChatgptConnectorRefreshAcceptable -Result $connectorRefresh))
        # Mobile-edge is observed and repaired opportunistically, but it is not part of the
        # console-mcp server ownership boundary and cannot make server/watchdog replacement fail.
        $serverOk = [bool]($finalChatgptState.running -and $finalChatgptState.port_open -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $codexOk -and $finalTunnelState.running -and $finalPublic.ok -eq $true -and $schemaPropagationOk)
        $ok = [bool]($serverOk -and ($browserOk -or $browserSessionBlocked))
        $status = if ($chatgptRuntimeRestarted -and -not $schemaPropagationOk) { 'FAILED_CONNECTOR_SCHEMA_PROPAGATION_UNCONFIRMED' } elseif ($ok -and $browserOk -and $actions.Count -gt 0) { 'HEALED' } elseif ($ok -and $browserOk) { 'HEALTHY' } elseif ($ok -and $browserSessionBlocked) { 'DEGRADED_BROWSER_RECOVERY_UNAVAILABLE' } elseif ($finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -ne $true) { 'FAILED_STALE_RUNTIME_NOT_REPLACED' } else { 'FAILED' }
        Invoke-WatchdogAlertIfNeeded -Status $status -Ok ([bool]$ok) -Reason $status
        return (Write-WatchdogState -Status $status -Ok ([bool]$ok) -Actions $actions -Detail @{ autologon = $autologon; console_session = $consoleSession; chatgpt_oauth = $finalChatgptState; chatgpt_freshness = $finalChatgptFreshness; codex_bearer = $finalCodexState; local_codex = $finalLocalCodex; tunnel = $finalTunnelState; local_chatgpt = $finalLocalChatgpt; public = $finalPublic; browser = $browserRecovery; server_recovery = [pscustomobject]@{ ok = $serverOk }; mobile_edge = $mobileEdge; connector_refresh = $connectorRefresh } | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Invoke-WatchdogAlertIfNeeded -Status 'FAILED' -Ok $false -Reason $message
        return (Write-WatchdogState -Status 'FAILED' -Ok $false -Actions $actions -ErrorMessage $message | ConvertTo-Json -Depth 20)
    } finally {
        Exit-WatchdogLock
    }
}

function Resolve-WatchdogPwshPath {
    $pwsh = Get-PwshCommand
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'),
        $pwsh.Source
    )
    $candidates += @(Get-Command pwsh -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    foreach ($candidate in @($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            & $candidate -NoProfile -NonInteractive -Command "exit 0"
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch { }
    }
    throw 'No runnable PowerShell 7 executable was found for the watchdog control plane.'
}

function Install-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop

    $taskPwshPath = Resolve-WatchdogPwshPath
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    # Task Scheduler discards the launched process's stdout/stderr by default - a failure inside
    # the task-launched 'start-watchdog-loop' invocation was previously completely invisible:
    # Start-WatchdogLoop would just poll for 20s, see nothing come up, and silently fall back to a
    # direct (session-unsafe) launch.
    #
    # A first attempt routed a single long `cmd.exe /c "..." ... "..." ... "..." >> "..." 2>&1`
    # string straight through -Argument. That failed outright (LastTaskResult=1, no log file ever
    # created) - cmd.exe's /c quote-stripping rule only behaves predictably when the ENTIRE
    # command is a single quoted token; with three separate quoted paths (pwsh.exe, the script, the
    # log file) concatenated in one string, cmd's parsing of where quoting starts/ends is
    # ambiguous and it can bail before doing anything, including before opening the redirect - so
    # even the failure was invisible. Avoid the whole class of bug: write a tiny, disposable .cmd
    # launcher file (regenerated on every install-watchdog-task) that does the real invocation with
    # ordinary batch-file quoting, and give Register-ScheduledTaskAction only ONE quoted token to
    # parse (`cmd.exe /c "<launcher.cmd path>"`), which is the one form of cmd /c quoting that is
    # unambiguous.
    $taskRunLog = Join-Path $LogDir 'console-mcp-watchdog-task-run.log'
    $taskLauncherPath = Join-Path $RunDir 'watchdog-task-bootstrap.ps1'
    $taskLaunchReceiptPath = Join-Path $RunDir 'watchdog-task-launch-receipt.json'
    $existingTask = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction Stop
        $stopDeadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $existingTask = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
        } while ($existingTask -and $existingTask.State -eq 'Running' -and (Get-Date) -lt $stopDeadline)
        if ($existingTask -and $existingTask.State -eq 'Running') {
            throw 'Existing watchdog Scheduled Task did not stop before launcher replacement.'
        }
    }
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $escapedReceiptPath = $taskLaunchReceiptPath.Replace("'", "''")
    $escapedTaskRunLog = $taskRunLog.Replace("'", "''")
    $launcherContent = @"
`$ErrorActionPreference = 'Stop'
`$receiptPath = '$escapedReceiptPath'
`$taskRunLog = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName('$escapedTaskRunLog'), "console-mcp-watchdog-task-run-`$PID.log")
`$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
`$receipt = [ordered]@{
    entered_at = (Get-Date).ToString('o')
    pid = `$PID
    session_id = `$sessionId
    user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    stage = 'bootstrap_entered'
    task_log = `$taskRunLog
    exit_code = `$null
    error = `$null
}
`$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath `$receiptPath -Encoding utf8
try {
    & '$escapedScriptPath' watchdog-loop-run *>> `$taskRunLog
    `$receipt.stage = 'watchdog_loop_returned'
    `$receipt.exit_code = if (`$LASTEXITCODE -is [int]) { `$LASTEXITCODE } else { 0 }
} catch {
    `$receipt.stage = 'watchdog_loop_failed'
    `$receipt.exit_code = 1
    `$receipt.error = `$_.Exception.ToString()
    `$_.Exception.ToString() | Add-Content -LiteralPath `$taskRunLog -Encoding utf8
} finally {
    `$receipt.completed_at = (Get-Date).ToString('o')
    `$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath `$receiptPath -Encoding utf8
}
exit [int]`$receipt.exit_code
"@
    $launcherTempPath = "$taskLauncherPath.$([guid]::NewGuid().ToString('N')).tmp"
    Set-Content -LiteralPath $launcherTempPath -Value $launcherContent -Encoding ascii -NoNewline
    Move-Item -LiteralPath $launcherTempPath -Destination $taskLauncherPath -Force
    $launcherActual = Get-Content -LiteralPath $taskLauncherPath -Raw
    if ($launcherActual -ne $launcherContent) {
        throw 'Atomic watchdog launcher verification failed.'
    }
    $action = New-ScheduledTaskAction -Execute $taskPwshPath -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$taskLauncherPath`"" -WorkingDirectory $Root
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    # Safety-net trigger: AtLogOn only fires once, at logon. If stop-server pauses the loop
    # (85-session-relay.ps1 / Invoke-ConsoleServerConfirmedStop) and the SSH session that issued
    # the request drops before the loop can be resumed (network blip, killed shell, timeout), the
    # only previous recovery path was a physical/RDP relogin. This repeats every 5 minutes
    # indefinitely and is a cheap no-op (MultipleInstances=IgnoreNew) whenever a loop is already
    # running, so it only ever matters in exactly that gap.
    # NOTE: -RepetitionDuration is deliberately omitted, not set to [TimeSpan]::MaxValue - the
    # latter serialises to an ISO-8601 duration (P99999999DT23H59M59S) that exceeds the Task
    # Scheduler XML schema's valid range and Register-ScheduledTask rejects it outright. Per
    # New-ScheduledTaskTrigger's documented behavior, omitting -RepetitionDuration while
    # -RepetitionInterval is set means the repetition has no end - genuinely indefinite, and valid.
    $periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $description = 'Repair-only watchdog for console-mcp ChatGPT OAuth and cloudflared public availability. Also the sole session-safe launcher for the unified console-mcp node runtime (see tool/dev-console.d/85-session-relay.ps1): SSH is the primary control point, and this task is what guarantees start/stop always lands in the interactive desktop session regardless of which session issued the command. Self-heals within 5 minutes if stopped without being resumed.'

    Register-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -Action $action -Trigger @($logonTrigger, $periodicTrigger) -Principal $principal -Settings $settings -Description $description -Force | Out-Null

    $registeredTask = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction Stop
    $registeredAction = @($registeredTask.Actions | Select-Object -First 1)
    $expectedArgument = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$taskLauncherPath`""
    if ($registeredAction.Count -ne 1 -or [string]$registeredAction[0].Execute -ne [string]$taskPwshPath -or [string]$registeredAction[0].Arguments -ne $expectedArgument) {
        throw 'WATCHDOG_TASK_ACTION_NOT_APPLIED'
    }
    return Show-WatchdogTask
}

function Uninstall-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop
    $existing = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -Confirm:$false | Out-Null
    }
    return [pscustomobject]@{ task_name = $WatchdogTaskName; removed = [bool]$existing } | ConvertTo-Json -Depth 6
}

function Show-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop
    $task = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{ task_name = $WatchdogTaskName; task_path = $StartupTaskPath; exists = $false; state = Get-WatchdogState } | ConvertTo-Json -Depth 8
    }
    $info = Get-ScheduledTaskInfo -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    $action = $task.Actions | Select-Object -First 1
    $trigger = $task.Triggers | Select-Object -First 1
    $actualDeclaration = Get-WatchdogTaskActualDeclaration -Task $task -Info $info
    $expectedDeclaration = Get-WatchdogTaskExpectedDeclaration
    $declaration = Compare-WatchdogTaskDeclaration -Actual $actualDeclaration -Expected $expectedDeclaration
    return [pscustomobject]@{
        task_name = $WatchdogTaskName
        task_path = $StartupTaskPath
        exists = $true
        task_state = [string]$task.State
        last_run_time = if ($info) { $info.LastRunTime } else { $null }
        next_run_time = if ($info) { $info.NextRunTime } else { $null }
        last_task_result = if ($info) { $info.LastTaskResult } else { $null }
        declaration = $declaration
        action = if ($action) { [pscustomobject]@{ execute = $action.Execute; arguments = $action.Arguments; working_directory = $action.WorkingDirectory } } else { $null }
        trigger = if ($trigger) { [pscustomobject]@{ enabled = $trigger.Enabled; start_boundary = $trigger.StartBoundary; repetition_interval = $trigger.Repetition.Interval; repetition_duration = $trigger.Repetition.Duration } } else { $null }
        state = Get-WatchdogStateStatus
    } | ConvertTo-Json -Depth 12
}

function Get-WatchdogLoopIntervalSeconds {
    $configured = $env:CONSOLE_MCP_WATCHDOG_LOOP_INTERVAL_SECONDS
    $parsed = 0
    if ($configured -and [int]::TryParse($configured, [ref]$parsed) -and $parsed -ge 2 -and $parsed -le 60) {
        return $parsed
    }
    return 5
}

function Write-WatchdogLoopState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )

    Ensure-Directories
    $state = [ordered]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        pid = $PID
        pid_file = $WatchdogLoopPidFile
        state_file = $WatchdogLoopStateFile
        log_file = $WatchdogLoopLogFile
        interval_seconds = Get-WatchdogLoopIntervalSeconds
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $json = ($state | ConvertTo-Json -Depth 30)
    $json | Set-Content -LiteralPath $WatchdogLoopStateFile -Encoding utf8
    Write-SafeLogLine -Path $WatchdogLoopLogFile -Text ($json -replace "`r?`n", ' ')
    return [pscustomobject]$state
}

function Get-WatchdogLoopProcessState {
    $loopPid = Get-ManagedPid -PidFile $WatchdogLoopPidFile
    $alive = $loopPid -and (Test-ManagedPid -ProcessId $loopPid)
    $process = if ($alive) { Get-CimInstance Win32_Process -Filter "ProcessId = $loopPid" -ErrorAction SilentlyContinue } else { $null }
    $state = if (Test-Path -LiteralPath $WatchdogLoopStateFile -PathType Leaf) {
        try { Get-Content -LiteralPath $WatchdogLoopStateFile -Raw | ConvertFrom-Json } catch { $null }
    } else { $null }

    return [pscustomobject]@{
        name = 'console-mcp-watchdog-loop'
        pid_file = $WatchdogLoopPidFile
        pid = if ($alive) { $loopPid } else { $null }
        running = [bool]$alive
        stale_pid_file = [bool]($loopPid -and -not $alive)
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        state_file = $WatchdogLoopStateFile
        log_file = $WatchdogLoopLogFile
        state = $state
    }
}

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
        # Wait for the loop to actually confirm itself (process alive AND heartbeat ticking), not
        # just for Start-Process to return - a launcher only hands off once the next stage has
        # proven it reached a working state, bounded so this can never hang indefinitely.
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

    # Prefer the Scheduled Task (Principal LogonType=Interactive) unconditionally: it is the only
    # launch path guaranteed to bind the resulting watchdog-loop-run process to the interactive
    # desktop session regardless of which session (SSH, RDP, interactive) issued this call. A raw
    # Start-Process here would instead bind the child to whichever session THIS PowerShell process
    # happens to be running in - exactly the session-drift bug this exists to prevent. SSH is the
    # primary control point for console-mcp; this makes that safe by construction instead of by
    # convention.
    $task = $null
    try {
        Import-Module ScheduledTasks -ErrorAction Stop
        $task = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    } catch {
        $task = $null
    }

    # Self-healing: do not require a human to have run install-watchdog-task by hand first. SSH is
    # meant to work as the primary control point from a cold machine, not just after manual setup -
    # a caller relying on convention ("someone remembered to install the task") is exactly the kind
    # of drift this module exists to eliminate. If the task is missing, register it now, with the
    # current (dual-trigger) definition, then proceed as if it had always been there.
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
        # Start-ScheduledTask is fire-and-forget; poll for the resulting watchdog-loop-run process
        # to actually come up instead of assuming success. 20s was too tight in practice: a cold
        # pwsh.exe start under Task Scheduler plus the AWS secret bootstrap for 'start-watchdog-loop'
        # (see $SecretBootstrapCommands) can take noticeably longer than the same call from an
        # already-warm interactive shell - observed ~25s end to end. A too-short poll window doesn't
        # just fail cleanly: it falls through to the direct fallback while the task-launched process
        # is still starting, so both a fallback loop AND the task's own loop can end up racing for
        # the PID file. Give it real headroom.
        $deadline = (Get-Date).AddSeconds(45)
        $polled = Get-WatchdogLoopProcessState
        $polledHeartbeat = Get-WatchdogLoopHeartbeatState -Loop $polled
        # Wait for a genuinely confirmed handoff (process alive AND heartbeat ticking), not merely
        # "a process exists" - the latter is exactly the false-positive that let a hung loop pass as
        # a successful launch.
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
        # Fall through to the direct-launch fallback only if the task exists but somehow did not
        # result in a confirmed-ready loop (e.g. task disabled, no interactive session yet, or the
        # process came up but never produced a fresh heartbeat).
    }

    # SSH-first invariant: never launch the broker directly from a non-interactive caller.
    # A direct fallback makes the stack appear healthy while silently binding Node/browser
    # ownership to the SSH session. Fail closed and preserve the diagnostic instead.
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

    # Belt-and-braces: the PID file only ever names ONE process, but a prior race between a
    # scheduled-task launch that was still starting and a direct-fallback launch that gave up too
    # early can leave a SECOND watchdog-loop-run alive that the PID file never pointed to. Sweep
    # for any other survivors by command line and kill those too, so 'restart' genuinely means zero
    # afterward, not 'zero of the one we happened to be tracking'.
    $survivors = @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'watchdog-loop-run' -and [int]$_.ProcessId -ne [int]$state.pid })
    foreach ($survivor in $survivors) {
        try {
            Stop-Process -Id ([int]$survivor.ProcessId) -Force -ErrorAction Stop
            $stopDetail.extra_instances_killed += [int]$survivor.ProcessId
        } catch { }
    }

    # Task Scheduler tracks a task's "Running" state independently of our PID file. If it still
    # believes console-mcp-watchdog has a live instance (e.g. because the process that instance
    # actually spawned was one of the survivors just killed above, not the one our PID file named),
    # every future Start-ScheduledTask call is silently ignored (MultipleInstances=IgnoreNew) and
    # Start-WatchdogLoop falls back to the session-unsafe direct launch every time, invisibly.
    # Explicitly release the task's own bookkeeping so the next start is never a silent no-op.
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

function Get-WatchdogCadenceDefinition {
    return [ordered]@{
        runtime = 5
        local_auth = 30
        browser = 60
        public_tunnel = 120
        task_integrity = 300
        build_fingerprint = 600
    }
}

function Get-WatchdogCadenceState {
    if (-not (Test-Path -LiteralPath $WatchdogCadenceStateFile -PathType Leaf)) {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null }
    }
    try { return Get-Content -LiteralPath $WatchdogCadenceStateFile -Raw | ConvertFrom-Json -Depth 30 } catch {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null }
    }
}

function Write-WatchdogCadenceState {
    param([Parameter(Mandatory = $true)]$State)
    $temporary = "$WatchdogCadenceStateFile.$PID.tmp"
    $State | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $WatchdogCadenceStateFile -Force
}

function Test-WatchdogCadenceLaneDue {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][int]$IntervalSeconds, [datetime]$Now = (Get-Date))
    $lane = $null
    try { $lane = $State.lanes.$Name } catch { $lane = $null }
    if (-not $lane -or [string]::IsNullOrWhiteSpace([string]$lane.completed_at)) { return $true }
    try { $completedAt = if ($lane.completed_at -is [datetime]) { $lane.completed_at.ToUniversalTime() } else { [datetimeoffset]::Parse([string]$lane.completed_at).UtcDateTime }; return ($Now.ToUniversalTime() - $completedAt).TotalSeconds -ge $IntervalSeconds } catch { return $true }
}

function Set-WatchdogCadenceLaneResult {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][int]$IntervalSeconds, [Parameter(Mandatory = $true)]$Result)
    $laneMap = [ordered]@{}
    foreach ($property in @($State.lanes.PSObject.Properties)) { $laneMap[$property.Name] = $property.Value }
    $laneMap[$Name] = [pscustomobject]@{
        interval_seconds = $IntervalSeconds
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
        ok = [bool]$Result.ok
        status = [string]$Result.status
        repair_required = [bool]$Result.repair_required
        detail = $Result.detail
    }
    $State.lanes = [pscustomobject]$laneMap
    return $State
}

function Invoke-WatchdogCadenceLane {
    param([Parameter(Mandatory = $true)][ValidateSet('runtime','local_auth','browser','public_tunnel','task_integrity','build_fingerprint')][string]$Name)
    try {
        switch ($Name) {
            'runtime' {
                $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
                $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
                $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
                $ok = [bool]($chatgpt.running -and $chatgpt.port_open -and $codex.running -and $codex.port_open -and $tunnel.running)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'RUNTIME_LIGHTWEIGHT_HEALTHY'}else{'RUNTIME_LIGHTWEIGHT_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{chatgpt=$chatgpt;codex=$codex;tunnel=$tunnel} }
            }
            'local_auth' {
                $chatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
                $codex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
                $ok = [bool]($chatgpt.ok -eq $true -and $codex.ok -eq $true)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'LOCAL_AUTH_HEALTHY'}else{'LOCAL_AUTH_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{chatgpt=$chatgpt;codex=$codex} }
            }
            'browser' {
                $browser = Get-BrowserStackHealthReport
                $lease = Get-InteractiveDesktopCapabilityLease
                $ok = [bool]($browser.ok -and $lease.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'BROWSER_WARMTH_HEALTHY'}else{'BROWSER_WARMTH_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{browser=$browser;lease=$lease} }
            }
            'public_tunnel' {
                $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
                $ok = [bool]($public.ok -eq $true)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'PUBLIC_TUNNEL_HEALTHY'}else{'PUBLIC_TUNNEL_UNHEALTHY'}; repair_required=(-not $ok); detail=$public }
            }
            'task_integrity' {
                $task = Show-WatchdogTask
                $autologon = Get-AutologonReport
                $console = Get-ConsoleSessionReport
                $taskOk = [bool]($task.exists -and $task.declaration -and $task.declaration.ok)
                $ok = [bool]($taskOk -and $autologon.ok -and $console.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'TASK_AND_SESSION_INTEGRITY_HEALTHY'}else{'TASK_AND_SESSION_INTEGRITY_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{task=$task;autologon=$autologon;console_session=$console} }
            }
            'build_fingerprint' {
                $build = Get-BuildOutputReport
                $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
                $freshness = Get-ChatgptRuntimeFreshness
                $ok = [bool]($build.build_current -and $freshness.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'BUILD_FINGERPRINT_HEALTHY'}else{'BUILD_FINGERPRINT_STALE'}; repair_required=(-not $ok); detail=[pscustomobject]@{build=$build;runtime_freshness=$freshness} }
            }
        }
    } catch {
        return [pscustomobject]@{ ok=$false; status='CADENCE_LANE_FAILED'; repair_required=$true; detail=[pscustomobject]@{lane=$Name;error=Sanitize-Text $_.Exception.Message;script_stack_trace=Sanitize-Text ([string]$_.ScriptStackTrace)} }
    }
}

function Invoke-WatchdogCadenceScheduler {
    param([object]$State = $null)
    if (-not $State) { $State = Get-WatchdogCadenceState }
    $connectorRefreshResolution = Resolve-PendingChatgptConnectorRefresh
    $definition = Get-WatchdogCadenceDefinition
    $executed = [System.Collections.Generic.List[object]]::new()
    $repairRequired = $false
    $slowLaneExecuted = $false
    foreach ($entry in $definition.GetEnumerator()) {
        if (-not (Test-WatchdogCadenceLaneDue -State $State -Name $entry.Key -IntervalSeconds ([int]$entry.Value))) { continue }
        # Never burst all slow probes after a fresh install, state-file loss, or long suspension.
        # The 5-second runtime lane may run alongside one slow lane; all remaining slow lanes are
        # deferred to subsequent one-second broker ticks.
        if ($entry.Key -ne 'runtime' -and $slowLaneExecuted) { continue }
        $result = Invoke-WatchdogCadenceLane -Name $entry.Key
        $State = Set-WatchdogCadenceLaneResult -State $State -Name $entry.Key -IntervalSeconds ([int]$entry.Value) -Result $result
        $executed.Add([pscustomobject]@{ name=$entry.Key; interval_seconds=[int]$entry.Value; result=$result }) | Out-Null
        if ($entry.Key -ne 'runtime') { $slowLaneExecuted = $true }
        if ($result.repair_required) { $repairRequired = $true }
    }

    $repair = $null
    if ($repairRequired) {
        $repairDue = $true
        if (-not [string]::IsNullOrWhiteSpace([string]$State.last_repair_at)) {
            try { $lastRepairAt = if ($State.last_repair_at -is [datetime]) { $State.last_repair_at.ToUniversalTime() } else { [datetimeoffset]::Parse([string]$State.last_repair_at).UtcDateTime }; $repairDue = ((Get-Date).ToUniversalTime() - $lastRepairAt).TotalSeconds -ge 30 } catch { $repairDue = $true }
        }
        if ($repairDue) {
            $repair = Invoke-WatchdogHeal | ConvertFrom-Json
            $State.last_repair_at = (Get-Date).ToUniversalTime().ToString('o')
            # The cadence lanes and Invoke-WatchdogHeal are two independently-maintained definitions
            # of "healthy" - trusting repair.ok alone as proof the failing lane(s) are actually fixed
            # risks exactly the kind of silent drift that happens when the same concept is judged in
            # two places that can be edited separately. Re-check only the lane(s) that triggered this
            # repair, using the SAME lane check that flagged them broken, and record whether that
            # check now agrees - rather than papering over any disagreement with a global heal.ok.
            $recheckedLanes = [System.Collections.Generic.List[object]]::new()
            foreach ($entry in $executed) {
                if (-not $entry.result.repair_required) { continue }
                $recheck = Invoke-WatchdogCadenceLane -Name $entry.name
                $State = Set-WatchdogCadenceLaneResult -State $State -Name $entry.name -IntervalSeconds $entry.interval_seconds -Result $recheck
                $recheckedLanes.Add([pscustomobject]@{ name = $entry.name; ok = [bool]$recheck.ok; status = [string]$recheck.status }) | Out-Null
            }
            $repairVerifiedByLane = [bool](-not (@($recheckedLanes) | Where-Object { $_.ok -ne $true }))
            $repair | Add-Member -NotePropertyName rechecked_lanes -NotePropertyValue @($recheckedLanes) -Force
            $repair | Add-Member -NotePropertyName repair_verified_by_lane -NotePropertyValue $repairVerifiedByLane -Force
        }
    }
    Write-WatchdogCadenceState -State $State
    $repairEffective = [bool]($repair -and $repair.ok -and $repair.repair_verified_by_lane -ne $false)
    return [pscustomobject]@{ ok=[bool](-not $repairRequired -or $repairEffective); status=if($repairRequired){if($repairEffective){'CADENCE_REPAIR_COMPLETED'}elseif($repair -and $repair.ok -and $repair.repair_verified_by_lane -eq $false){'CADENCE_REPAIR_UNVERIFIED_BY_LANE'}elseif($repair){'CADENCE_REPAIR_FAILED'}else{'CADENCE_REPAIR_COOLDOWN'}}else{'CADENCE_HEALTHY'}; executed=@($executed); repair=$repair; connector_refresh_resolution=$connectorRefreshResolution; state=$State }
}

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

function Save-ExpectedSurface {
    param([string[]]$ToolNames)

    Ensure-Directories
    $payload = [pscustomobject]@{
        generated_at = (Get-Date).ToString('o')
        tool_names = @($ToolNames | Sort-Object -Unique)
    }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ExpectedSurfaceFile -Encoding utf8
    return $payload
}

function Invoke-ColdRestartPreparation {
    $npm = Get-NpmCommand
    Push-Location $Root
    try {
        $output = & $npm install 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        $message = Sanitize-Text (($output | Out-String).Trim())
        throw "npm install failed during cold restart preparation. $message"
    }

    return [pscustomobject]@{ ok = $true; command = 'npm install' }
}

function Test-ExpectedToolsFromSmoke {
    param([object]$Smoke, [string[]]$ExpectedTools = @())

    $expected = @($ExpectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    if ($expected.Count -eq 0) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = 'no expected tools configured'; expected = @(); missing = @() }
    }

    $available = @()
    if ($Smoke -and $Smoke.PSObject.Properties.Name -contains 'list_tools') {
        $available = @($Smoke.list_tools)
    }

    $comparison = Compare-ToolSurface -ExpectedTools $expected -RuntimeTools $available
    $readinessOk = $comparison.missing_count -eq 0
    return [pscustomobject]@{
        ok = $readinessOk
        skipped = $false
        source = 'authenticated MCP tool list'
        readiness_status = if ($readinessOk) { 'EXPECTED_TOOLS_PRESENT' } else { 'EXPECTED_TOOLS_MISSING' }
        expected = $expected
        runtime = @($available | Sort-Object -Unique)
        comparison = $comparison
    }
}

function Wait-ManagedServiceReady {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [string[]]$ExpectedTools = @(),
        [int]$TimeoutSeconds = 45,
        [int]$IntervalMilliseconds = 500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $state = Get-ManagedProcessState -Spec $Spec
        if ($state.running -and $state.port_open) {
            if ($Kind -eq 'chatgpt') {
                $last = Invoke-ChatgptSmoke -Origin $Origin -Label 'local-chatgpt' -Quiet
                if ($last.ok -eq $true) {
                    return [pscustomobject]@{
                        ok = $true
                        process = $state
                        smoke = $last
                        expected_tools = [pscustomobject]@{ skipped = $true; reason = 'oauth profile readiness is transport-level; authenticated surface is checked through codex profile' }
                    }
                }
            } else {
                $last = Invoke-CodexSmoke -Origin $Origin -Label 'local-codex' -Quiet
                if ($last.ok -eq $true) {
                    $toolCheck = Test-ExpectedToolsFromSmoke -Smoke $last.authenticated_smoke -ExpectedTools $ExpectedTools
                    if ($toolCheck.ok -eq $true) {
                        return [pscustomobject]@{ ok = $true; process = $state; smoke = $last; expected_tools = $toolCheck }
                    }
                }
            }
        } else {
            $last = [pscustomobject]@{ ok = $false; reason = 'process-not-ready'; process = $state }
        }

        Start-Sleep -Milliseconds $IntervalMilliseconds
    }

    throw ("{0} did not become ready within {1} seconds. Last result: {2}" -f $Spec.Name, $TimeoutSeconds, (($last | ConvertTo-Json -Depth 20 -Compress)))
}

function Invoke-ManagedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode,
        [string[]]$ExpectedTools = @()
    )

    $spec = if ($Kind -eq 'chatgpt') { Get-ChatgptSpec } else { Get-CodexSpec }
    $origin = if ($Kind -eq 'chatgpt') { $ChatgptOrigin } else { $CodexOrigin }
    $start = if ($Kind -eq 'chatgpt') { { Start-ChatgptOauth | Out-Null } } else { { Start-CodexBearer | Out-Null } }
    $stop = if ($Kind -eq 'chatgpt') { { Stop-ChatgptOauth | Out-Null } } else { { Stop-CodexBearer | Out-Null } }

    if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }

    if ($Mode -in @('warm', 'cold')) {
        Ensure-BuildOutput | Out-Null
        & $stop
        & $start
    } else {
        $state = Get-ManagedProcessState -Spec $spec
        if (-not $state.running) { & $start }
    }

    return Wait-ManagedServiceReady -Spec $spec -Origin $origin -Kind $Kind -ExpectedTools $ExpectedTools
}

function Invoke-RestartAllSupervised {
    param([Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode)

    $preflight = Invoke-WatchdogPreflight -Purpose "restart-all-$Mode"
    Invoke-StackSnapshot -Purpose "restart-all-$Mode-before" | Out-Null
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'BUILDING' -Mode $Mode -Scope 'all' -Detail @{ expected_tools = $expectedTools } | Out-Null

    try {
        if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }
        if ($Mode -in @('warm', 'cold')) { Ensure-BuildOutput | Out-Null }

        Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICES' -Mode $Mode -Scope 'all' | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode $Mode -ExpectedTools @()
        $codex = Invoke-ManagedRestart -Kind 'codex' -Mode $Mode -ExpectedTools $expectedTools

        Write-RestartState -Generation $generation -Status 'REVERIFYING_LOCAL_CHATGPT' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex } | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'soft' -ExpectedTools @()
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt'

        Write-RestartState -Generation $generation -Status 'WAITING_PUBLIC_READY' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex; auth_runtime = $authRuntime } | Out-Null
        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            Start-Tunnel | Out-Null
        } elseif ($Mode -eq 'cold') {
            Stop-Tunnel | Out-Null
            Start-Tunnel | Out-Null
        }
        $public = Wait-PublicSmokeReady
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt' -RequirePublic

        Write-RestartState -Generation $generation -Status 'VERIFYING_BROWSER_POSTCONDITION' -Mode $Mode -Scope 'all' -Detail @{ public = $public; auth_runtime = $authRuntime } | Out-Null
        $browserPostcondition = Invoke-BrowserFreshPostcondition -Purpose "restart-all-$Mode"

        $refresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        $readyStatus = if ($refresh.ok -ne $true) { 'READY_SCHEMA_PROPAGATION_UNCONFIRMED' } elseif ($browserPostcondition.ok -eq $true) { 'READY' } else { 'READY_BROWSER_NOT_READY' }

        $ready = [pscustomobject]@{ ok = [bool]($refresh.ok -eq $true); generation = $generation; mode = $Mode; status = $readyStatus; chatgpt = $chatgpt; codex = $codex; public = $public; browser = $browserPostcondition; connector_refresh = $refresh }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope 'all' -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        New-ServerLifecycleLaunchPrompt -Operation 'restart-all' -Generation $generation -Mode $Mode -Status $readyStatus -Detail $ready | Out-Null
        Invoke-StackSnapshot -Purpose "restart-all-$Mode-after-$readyStatus" | Out-Null
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope 'all' -ErrorMessage $message | Out-Null
        throw $message
    }
}

function Invoke-SingleServiceSupervisedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode
    )

    $preflight = $null
    if ($Kind -eq 'chatgpt') {
        $preflight = Invoke-WatchdogPreflight -Purpose "restart-$Kind-$Mode"
        Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-before" | Out-Null
    }
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICE' -Mode $Mode -Scope $Kind | Out-Null

    try {
        $result = Invoke-ManagedRestart -Kind $Kind -Mode $Mode -ExpectedTools $expectedTools
        $connectorRefresh = $null
        if ($Kind -eq 'chatgpt') {
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        }
        $connectorRefreshAcceptable = [bool]($Kind -ne 'chatgpt' -or (Test-ChatgptConnectorRefreshAcceptable -Result $connectorRefresh))
        $readyStatus = if ($Kind -eq 'chatgpt' -and $connectorRefresh.status -eq 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING') { 'READY_SCHEMA_PROPAGATION_PENDING' } elseif (-not $connectorRefreshAcceptable) { 'READY_SCHEMA_PROPAGATION_UNCONFIRMED' } else { 'READY' }
        $ready = [pscustomobject]@{ ok = $connectorRefreshAcceptable; generation = $generation; mode = $Mode; scope = $Kind; status = $readyStatus; service = $result; connector_refresh = $connectorRefresh; expected_tools = $expectedTools }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope $Kind -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        if ($Kind -eq 'chatgpt') {
            Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-after-$readyStatus" | Out-Null
        }
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope $Kind -ErrorMessage $message | Out-Null
        throw $message
    }
}

function Get-TunnelSpec {
    return [pscustomobject]@{
        Name = 'cloudflared-console-mcp'
        PidFile = $TunnelPidFile
        LogFile = $TunnelLogFile
        ConfigFile = $CloudflaredConfig
        Matcher = '(?i)cloudflared\b.*\btunnel\b.*\brun\s+console-mcp\b'
        UseMatcherFallback = $true
    }
}

function Get-RestartAllPlan {
    $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $build = Get-BuildOutputReport
    $freshness = Get-ChatgptRuntimeFreshness
    $browser = Get-BrowserStackHealthReport
    $blocked = @()
    if ($build.build_needed) { $blocked += 'build_output_stale' }
    if ($chatgpt.port_conflict -or $codex.port_conflict) { $blocked += 'port_conflict' }
    if ($browser.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED') { $blocked += 'interactive_browser_recovery_required' }
    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RESTART_ALL_PLAN_READY' } else { 'RESTART_ALL_PLAN_BLOCKED' }
        command = 'restart-all'
        mode = 'warm'
        will_stop_anything = $false
        target_profiles = @('chatgpt-oauth', 'codex-bearer', 'tunnel')
        safe_to_execute = $safe
        reason = if ($safe) { 'preflight_ready' } else { 'preflight_blocked' }
        blocked_reasons = $blocked
        build_output = $build
        freshness = $freshness
        services = [pscustomobject]@{
            chatgpt_oauth = $chatgpt
            codex_bearer = $codex
            tunnel = $tunnel
        }
        browser = $browser
        restart = Get-RestartState
        next_action = if ($safe) { 'run restart-all only if a broad stack restart is explicitly intended' } else { 'inspect blockers before restart-all' }
    } | ConvertTo-Json -Depth 30
}

function Get-RuntimeReplaceState {
    if (-not (Test-Path -LiteralPath $RuntimeReplaceStateFile -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $RuntimeReplaceStateFile -Raw | ConvertFrom-Json -Depth 20)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'RUNTIME_REPLACE_STATE_UNREADABLE'
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Write-RuntimeReplaceState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object]$Plan = $null,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )
    Ensure-Directories
    $state = [pscustomobject]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        state_file = $RuntimeReplaceStateFile
        plan = $Plan
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $RuntimeReplaceStateFile -Encoding utf8
    Write-ServerLifecycleEvent -Operation 'runtime-replace' -Mode 'warm' -Scope 'chatgpt' -Phase $Status -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return $state
}

function New-ConsoleDevRuntimeReplacePlan {
    param(
        [ValidateSet('chatgpt')][string]$Kind = 'chatgpt',
        [ValidateSet('warm')][string]$Mode = 'warm',
        [int]$CooldownSeconds = 90
    )
    $spec = Get-ChatgptSpec
    $service = Get-ManagedProcessState -Spec $spec
    $freshness = Get-ChatgptRuntimeFreshness
    $local = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $build = Get-BuildOutputReport
    $last = Get-RuntimeReplaceState
    $blocked = @()
    $staleProof = @()

    foreach ($reason in @($freshness.reasons)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$reason)) { $staleProof += [string]$reason }
    }
    if ($freshness.status -eq 'STALE' -and $staleProof.Count -eq 0) { $staleProof += 'runtime_stale' }

    if ($service.port_conflict) { $blocked += 'foreign_listener_or_port_conflict' }
    if (-not $service.running) { $blocked += 'target_runtime_not_running' }
    if (-not $service.port_open) { $blocked += 'target_port_not_open' }
    if ($local.ok -ne $true) { $blocked += 'local_runtime_not_healthy' }
    if ($freshness.ok -eq $true) { $blocked += 'runtime_already_current' }
    if ($staleProof.Count -eq 0) { $blocked += 'missing_explicit_stale_proof' }

    $lastAt = $null
    if ($last -and $last.at) {
        try { $lastAt = [datetime]::Parse([string]$last.at).ToUniversalTime() } catch { $lastAt = $null }
    }
    $lastAgeSeconds = if ($lastAt) { [Math]::Round(((Get-Date).ToUniversalTime() - $lastAt).TotalSeconds, 3) } else { $null }
    if ($lastAgeSeconds -ne $null -and $lastAgeSeconds -lt $CooldownSeconds -and $freshness.ok -ne $true) {
        $blocked += 'cooldown_active_after_recent_replace'
    }

    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RUNTIME_REPLACE_PLAN_READY' } else { 'RUNTIME_REPLACE_PLAN_BLOCKED' }
        command = 'runtime-replace-stale'
        mode = $Mode
        will_stop_anything = $safe
        target_profiles = @($spec.Name)
        reason = if ($safe) { 'stale_runtime_proven' } else { 'precondition_blocked' }
        safe_to_execute = $safe
        stale_proof = @($staleProof)
        blocked_reasons = @($blocked | Sort-Object -Unique)
        cooldown_seconds = $CooldownSeconds
        last_replace_age_seconds = $lastAgeSeconds
        service = $service
        freshness = $freshness
        local = $local
        build_output = $build
        last_replace = $last
        next_action = if ($safe) { 'run runtime-replace-stale to replace only chatgpt-oauth' } else { 'do not stop runtime; inspect blocked_reasons' }
    }
}

function Assert-ConsoleDevRuntimeReplacePrerequisiteShape {
    param([Parameter(Mandatory = $true)]$Plan)
    $targets = @($Plan.target_profiles)
    if ($targets.Count -ne 1 -or $targets[0] -ne 'chatgpt-oauth') {
        throw 'Runtime replace plan must target only chatgpt-oauth.'
    }
    if ($Plan.safe_to_execute -eq $true -and @($Plan.stale_proof).Count -eq 0) {
        throw 'Runtime replace plan cannot execute without explicit stale proof.'
    }
    if ($Plan.safe_to_execute -eq $true -and $Plan.will_stop_anything -ne $true) {
        throw 'Executable runtime replace plan must disclose will_stop_anything=true.'
    }
    return $Plan
}

function Invoke-ConsoleDevRuntimeReplaceStale {
    $plan = Assert-ConsoleDevRuntimeReplacePrerequisiteShape -Plan (New-ConsoleDevRuntimeReplacePlan)
    if ($plan.safe_to_execute -ne $true) {
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_BLOCKED' -Ok $false -Plan $plan -Detail @{ blocked_reasons = $plan.blocked_reasons }
        return ($state | ConvertTo-Json -Depth 30)
    }

    Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_REPLACING' -Ok $false -Plan $plan | Out-Null
    try {
        $result = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools @()
        $postcondition = Invoke-AuthRuntimePostcondition -Kind 'chatgpt'
        $ok = [bool]($postcondition.ok -eq $true)
        $replaceStatus = if ($ok) { 'RUNTIME_REPLACE_READY' } else { 'RUNTIME_REPLACE_POSTCONDITION_FAILED' }
        $state = Write-RuntimeReplaceState -Status $replaceStatus -Ok $ok -Plan $plan -Detail @{ restart = $result; postcondition = $postcondition }
        return ($state | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_FAILED' -Ok $false -Plan $plan -ErrorMessage $message
        return ($state | ConvertTo-Json -Depth 30)
    }
}

