function Get-InteractiveDesktopCapabilityLease {
    param([switch]$RequireVisibleWindow)
    $health = Get-BrowserStackHealthReport
    $consoleSession = Get-ConsoleSessionReport
    $currentSessionId = $null
    try { $currentSessionId = (Get-Process -Id $PID).SessionId } catch { $currentSessionId = $null }
    $activeConsoleSessionId = if ($consoleSession.active_console) { [int]$consoleSession.active_console.id } else { $null }
    $sessionMatches = [bool]($activeConsoleSessionId -ne $null -and $currentSessionId -eq $activeConsoleSessionId)
    $explorer = if ($activeConsoleSessionId -ne $null) { @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Where-Object { [int]$_.SessionId -eq $activeConsoleSessionId }) } else { @() }
    $edge = if ($activeConsoleSessionId -ne $null) { @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { [int]$_.SessionId -eq $activeConsoleSessionId }) } else { @() }
    $visibleOk = [bool](-not $RequireVisibleWindow -or $health.microsoft_edge.visible_window_detected)
    $ok = [bool]($consoleSession.ok -and $sessionMatches -and $explorer.Count -gt 0 -and $edge.Count -gt 0 -and $health.cdp_9223.ok -and $health.target_inventory.chatgpt_target_count -gt 0 -and $visibleOk)
    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'INTERACTIVE_DESKTOP_LEASE_READY' } else { 'INTERACTIVE_DESKTOP_LEASE_UNAVAILABLE' }
        current_session_id = $currentSessionId
        active_console_session_id = $activeConsoleSessionId
        session_matches = $sessionMatches
        explorer_count = $explorer.Count
        edge_count = $edge.Count
        require_visible_window = [bool]$RequireVisibleWindow
        browser = $health
    }
}

function Invoke-BrowserRelaunchVisible {
    param([string]$Purpose = 'manual')

    $lease = Get-InteractiveDesktopCapabilityLease -RequireVisibleWindow
    if (-not $lease.ok) {
        throw ("Browser relaunch blocked: interactive desktop lease unavailable. current_session_id={0}; active_console_session_id={1}; explorer_count={2}; edge_count={3}" -f $lease.current_session_id, $lease.active_console_session_id, $lease.explorer_count, $lease.edge_count)
    }
    $before = Get-BrowserStackHealthReport
    $consoleSession = Get-ConsoleSessionReport
    $currentSessionId = (Get-Process -Id $PID).SessionId
    $activeConsoleSessionId = if ($consoleSession.active_console) { [int]$consoleSession.active_console.id } else { $null }
    if ($before.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED' -and ($activeConsoleSessionId -eq $null -or $currentSessionId -ne $activeConsoleSessionId)) {
        throw (("Browser relaunch requires an interactive desktop session. This process is running in Windows session {1}, but the active console (interactive desktop) session is {2}. Re-run this command from a PowerShell/Windows Terminal window opened directly in the interactive desktop session (locally, or via RDP as the same Windows user) rather than via remoting/services/scheduled tasks/SSH; verify with 'query session' that your terminal's row shows 'console'+'Active' with ID {2}. " +
            "next_action={0}; current_session_id={1}; active_console_session_id={2}") -f $before.next_action, $currentSessionId, $activeConsoleSessionId)
    }
    $profilePlan = Resolve-BrowserUserDataDir
    $portPattern = '--remote-debugging-port=9223'
    $profilePattern = [string]$profilePlan.path
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    $matched = @()
    $stopped = @()
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        $matchesPort = $commandLine.Contains($portPattern)
        $matchesProfile = (-not [string]::IsNullOrWhiteSpace($profilePattern)) -and $commandLine.Contains($profilePattern)
        if ($matchesPort -or $matchesProfile) {
            $matched += $process
            try {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
                $stopped += [pscustomobject]@{ pid = $process.ProcessId; session_id = $process.SessionId; stopped = $true; matched_port = $matchesPort; matched_profile = $matchesProfile }
            } catch {
                $stopped += [pscustomobject]@{ pid = $process.ProcessId; session_id = $process.SessionId; stopped = $false; matched_port = $matchesPort; matched_profile = $matchesProfile; error = Sanitize-Text $_.Exception.Message }
            }
        }
    }

    Start-Sleep -Seconds 2
    $started = Start-VisibleEdge
    $after = Get-BrowserStackHealthReport
    if (-not $after.ok) {
        foreach ($attempt in 1..10) {
            Start-Sleep -Seconds 1
            $after = Get-BrowserStackHealthReport
            if ($after.ok) { break }
        }
    }

    $result = [pscustomobject]@{
        ok = [bool]$after.ok
        status = if ($after.ok) { 'BROWSER_RELAUNCHED' } else { 'BROWSER_RELAUNCH_UNHEALTHY' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        before = $before
        profile_plan = $profilePlan
        stop = [pscustomobject]@{ port = 9223; matched_count = $matched.Count; stopped = $stopped }
        started = $started
        after = $after
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "browser-relaunch-$Purpose") -Payload $result | Out-Null
    if (-not $result.ok) { throw "Browser relaunch failed. next_action=$($after.next_action)" }
    return $result
}
