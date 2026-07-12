function Invoke-BrowserEnsureVisible {
    param([string]$Purpose = 'manual', [switch]$PassThroughFailure)
    $before = Get-BrowserStackHealthReport
    $started = $null
    $recoveryRequired = $before.next_action -in @(
        'EDGE_LAUNCH_REQUIRED',
        'EDGE_VISIBLE_WINDOW_REQUIRED',
        'CDP_RECOVERY_REQUIRED',
        'CHATGPT_VISIBLE_PAGE_REQUIRED'
    )
    $consoleSession = Get-ConsoleSessionReport
    $currentSessionId = (Get-Process -Id $PID).SessionId
    $activeConsoleSessionId = if ($consoleSession.active_console) { [int]$consoleSession.active_console.id } else { $null }
    $currentProcessOwnsInteractiveDesktop = [bool]($activeConsoleSessionId -ne $null -and $currentSessionId -eq $activeConsoleSessionId)
    $blockedByDesktopBoundary = $false
    if (-not $before.ok -and $recoveryRequired) {
        if ($before.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED' -and -not $currentProcessOwnsInteractiveDesktop) {
            $blockedByDesktopBoundary = $true
        } elseif ($before.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED' -and (Get-Command Invoke-BrowserRelaunchVisible -ErrorAction SilentlyContinue)) {
            $started = Invoke-BrowserRelaunchVisible -Purpose "$Purpose-visible-window"
        } else {
            $started = Start-VisibleEdge
        }
    }
    $after = Get-BrowserStackHealthReport
    if (-not $after.ok -and $started) {
        foreach ($attempt in 1..10) {
            Start-Sleep -Seconds 1
            $after = Get-BrowserStackHealthReport
            if ($after.ok) { break }
        }
    }
    $remoteOnlyHealthy = [bool]($blockedByDesktopBoundary -and $after.cdp_9223.ok -eq $true -and $after.target_inventory.chatgpt_target_count -gt 0)
    $remoteOnlyWarning = if ($remoteOnlyHealthy) {
        "browser and CDP are healthy, but visible-window verification was skipped because this process is not running in the interactive desktop session (session_id mismatch: current_session_id=$currentSessionId, active_console_session_id=$activeConsoleSessionId) -- this is expected under SSH/autologin-without-interactive-login setups"
    } else { $null }
    $result = [pscustomobject]@{
        ok = [bool]($after.ok -or $remoteOnlyHealthy)
        status = if ($after.ok) { if ($started) { 'BROWSER_HEALED' } else { 'BROWSER_HEALTHY' } } elseif ($remoteOnlyHealthy) { 'BROWSER_HEALTHY_REMOTE_ONLY' } else { 'BROWSER_UNHEALTHY' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        before = $before
        recovery_required = [bool]$recoveryRequired
        recovery_action = if ($remoteOnlyHealthy) { 'NONE_REMOTE_ONLY_VERIFIED' } elseif ($blockedByDesktopBoundary) { 'INTERACTIVE_DESKTOP_REQUIRED' } elseif ($started) { 'START_VISIBLE_EDGE' } elseif ($before.ok) { 'NONE' } else { 'NO_SAFE_RECOVERY_ACTION' }
        desktop_boundary = [pscustomobject]@{ blocked = $blockedByDesktopBoundary; current_session_id = $currentSessionId; active_console_session_id = $activeConsoleSessionId; current_process_owns_interactive_desktop = $currentProcessOwnsInteractiveDesktop; console_session = $consoleSession }
        remote_only_healthy = $remoteOnlyHealthy
        warning = $remoteOnlyWarning
        started = $started
        after = $after
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "browser-$Purpose") -Payload $result | Out-Null
    if (-not $result.ok) {
        if ($PassThroughFailure) {
            return $result
        }
        if ($blockedByDesktopBoundary) {
            throw ("Browser visible recovery requires an interactive desktop session. This process is running in Windows session {1}, but the active console session (the real desktop) is session {2} — Windows isolates non-console sessions (services, Scheduled Tasks set to 'Run whether user is logged on or not', PowerShell Remoting/WinRM, some SSH logons) from the interactive window station, so a visible browser window can never be created or observed from here, even though the browser stack itself is otherwise fine (cdp_ok={3}, chatgpt_target_count={4}). " +
                "Fix: re-run this command from a PowerShell/Windows Terminal window opened directly in the interactive desktop session (locally, or via RDP as the same Windows user) instead of via remoting/services/scheduled tasks/SSH. Verify first with 'query session' — the row you are typing this command from must show 'console' and 'Active' with ID {2}, not {1}. " +
                "next_action={0}; current_session_id={1}; active_console_session_id={2}; cdp_ok={3}; chatgpt_target_count={4}" -f $after.next_action, $currentSessionId, $activeConsoleSessionId, $after.cdp_9223.ok, $after.target_inventory.chatgpt_target_count)
        }
        throw ("Browser visible recovery failed. next_action={0}; marker_present={1}; edge_process_count={2}; cdp_ok={3}; chatgpt_target_count={4}; cdp_error={5}; target_error={6}" -f $after.next_action, [bool]$after.marker, $after.microsoft_edge.interactive_process_count, $after.cdp_9223.ok, $after.target_inventory.chatgpt_target_count, $after.cdp_9223.error, $after.target_inventory.error)
    }
    return $result
}

Set-Variable -Name DevConsoleBrowserRecoveryModuleLoaded -Scope Script -Value $true -Force
