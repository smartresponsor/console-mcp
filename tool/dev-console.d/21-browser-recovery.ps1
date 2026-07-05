function Invoke-BrowserEnsureVisible {
    param([string]$Purpose = 'manual')
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
    $result = [pscustomobject]@{
        ok = [bool]$after.ok
        status = if ($after.ok) { if ($started) { 'BROWSER_HEALED' } else { 'BROWSER_HEALTHY' } } else { 'BROWSER_UNHEALTHY' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        before = $before
        recovery_required = [bool]$recoveryRequired
        recovery_action = if ($blockedByDesktopBoundary) { 'INTERACTIVE_DESKTOP_REQUIRED' } elseif ($started) { 'START_VISIBLE_EDGE' } elseif ($before.ok) { 'NONE' } else { 'NO_SAFE_RECOVERY_ACTION' }
        desktop_boundary = [pscustomobject]@{ blocked = $blockedByDesktopBoundary; current_session_id = $currentSessionId; active_console_session_id = $activeConsoleSessionId; current_process_owns_interactive_desktop = $currentProcessOwnsInteractiveDesktop; console_session = $consoleSession }
        started = $started
        after = $after
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "browser-$Purpose") -Payload $result | Out-Null
    if (-not $result.ok) {
        if ($blockedByDesktopBoundary) {
            throw ("Browser visible recovery requires interactive desktop. next_action={0}; current_session_id={1}; active_console_session_id={2}; cdp_ok={3}; chatgpt_target_count={4}" -f $after.next_action, $currentSessionId, $activeConsoleSessionId, $after.cdp_9223.ok, $after.target_inventory.chatgpt_target_count)
        }
        throw ("Browser visible recovery failed. next_action={0}; marker_present={1}; edge_process_count={2}; cdp_ok={3}; chatgpt_target_count={4}; cdp_error={5}; target_error={6}" -f $after.next_action, [bool]$after.marker, $after.microsoft_edge.interactive_process_count, $after.cdp_9223.ok, $after.target_inventory.chatgpt_target_count, $after.cdp_9223.error, $after.target_inventory.error)
    }
    return $result
}

Set-Variable -Name DevConsoleBrowserRecoveryModuleLoaded -Scope Script -Value $true -Force
