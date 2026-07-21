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

