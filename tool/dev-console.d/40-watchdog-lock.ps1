function Enter-WatchdogLock {
    Ensure-Directories
    $now = Get-Date
    if (Test-Path -LiteralPath $WatchdogLockFile -PathType Leaf) {
        $lockItem = Get-Item -LiteralPath $WatchdogLockFile -ErrorAction SilentlyContinue
        $lock = $null
        try {
            $lock = Get-Content -LiteralPath $WatchdogLockFile -Raw | ConvertFrom-Json
        } catch {
            $lock = $null
        }

        $lockPid = if ($lock -and $lock.pid) { [int]$lock.pid } else { $null }
        $lockProcess = if ($lockPid) { Get-Process -Id $lockPid -ErrorAction SilentlyContinue } else { $null }
        $lockAgeSeconds = if ($lockItem) { (($now.ToUniversalTime() - $lockItem.LastWriteTimeUtc).TotalSeconds) } else { 999999 }
        $lockIsFresh = [bool]($lockAgeSeconds -lt 300)
        $lockIsSelfOwned = [bool]($lockPid -eq $PID)
        $lockCommandLine = if ($lock -and $lock.command_line) { [string]$lock.command_line } else { '' }
        $lockClaimsWatchdogLoop = $lockCommandLine -match 'watchdog-loop-run'
        $registeredLoop = if ($lockClaimsWatchdogLoop) { Get-WatchdogLoopProcessState } else { $null }
        $lockIsRegisteredLoop = [bool]($registeredLoop -and $registeredLoop.running -and $registeredLoop.pid -and [int]$registeredLoop.pid -eq $lockPid)

        if ($lockIsFresh -and $lockProcess -and -not $lockIsSelfOwned -and (-not $lockClaimsWatchdogLoop -or $lockIsRegisteredLoop)) {
            return $false
        }

        Remove-Item -LiteralPath $WatchdogLockFile -Force -ErrorAction SilentlyContinue
    }

    $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        pid = $PID
        owner = 'watchdog-heal'
        session_id = (Get-Process -Id $PID).SessionId
        at = $now.ToString('o')
        heartbeat_at = $now.ToString('o')
        command_line = if ($currentProcess) { Sanitize-Text $currentProcess.CommandLine } else { $null }
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $WatchdogLockFile -Encoding utf8
    return $true
}

function Exit-WatchdogLock {
    if (-not (Test-Path -LiteralPath $WatchdogLockFile -PathType Leaf)) {
        return
    }

    $lock = $null
    try {
        $lock = Get-Content -LiteralPath $WatchdogLockFile -Raw | ConvertFrom-Json
    } catch {
        $lock = $null
    }

    if ($lock -and $lock.pid -and [int]$lock.pid -ne $PID) {
        return
    }

    Remove-Item -LiteralPath $WatchdogLockFile -Force -ErrorAction SilentlyContinue
}

