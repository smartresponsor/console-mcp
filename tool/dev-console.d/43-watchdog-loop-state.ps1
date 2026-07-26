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

