function Get-DesktopPreflightReport {
    $currentSessionId = [int](Get-Process -Id $PID).SessionId
    $consoleSession = Get-ConsoleSessionReport
    $browser = Get-BrowserStackHealthReport
    $controlSessionInteractive = $currentSessionId -gt 0
    $browserDevtoolsReady = [bool]($browser.cdp_9223.ok -or $browser.ok)
    $chatgptTarget = [bool]($browser.target_inventory.chatgpt_target_count -gt 0)
    $heartbeat = $null
    $heartbeatFresh = $false
    if (Test-Path -LiteralPath $DesktopAgentStateFile) {
        try {
            $heartbeat = Get-Content -LiteralPath $DesktopAgentStateFile -Raw | ConvertFrom-Json
            if ($heartbeat.last_seen_at) { $heartbeatFresh = (((Get-Date).ToUniversalTime() - ([datetime]::Parse([string]$heartbeat.last_seen_at).ToUniversalTime())).TotalSeconds -lt 60) }
        } catch { $heartbeat = $null }
    }
    $mode = 'desktop_recovery_required'
    $reason = 'desktop_recovery_required'
    if ($controlSessionInteractive -and $browserDevtoolsReady -and $chatgptTarget) { $mode = 'interactive_desktop_ready'; $reason = 'ok' }
    elseif (-not $controlSessionInteractive -and $browserDevtoolsReady -and $chatgptTarget) { $mode = 'remote_control_ready'; $reason = 'control_session_noninteractive_but_browser_devtools_ready' }
    elseif (-not $browserDevtoolsReady) { $reason = 'devtools_unavailable' }
    elseif (-not $chatgptTarget) { $reason = 'chatgpt_target_missing' }
    elseif (-not $controlSessionInteractive) { $reason = 'no_interactive_session' }
    return [pscustomobject]@{ ok = $mode -ne 'desktop_recovery_required'; mode = $mode; reason = $reason; control_session_interactive = $controlSessionInteractive; browser_devtools_ready = $browserDevtoolsReady; chatgpt_target = $chatgptTarget; current_session_id = $currentSessionId; console_session = $consoleSession; browser = $browser; desktop_agent_heartbeat_file = $DesktopAgentStateFile; desktop_agent_heartbeat_fresh = $heartbeatFresh; desktop_agent_heartbeat = $heartbeat }
}

function Get-DesktopHealPlan {
    $preflight = Get-DesktopPreflightReport
    $actions = @()
    if ($preflight.mode -eq 'remote_control_ready') { if (-not $preflight.desktop_agent_heartbeat_fresh) { $actions += 'optional_refresh_desktop_agent_heartbeat' } }
    else {
        if (-not $preflight.control_session_interactive) { $actions += 'interactive_session_required' }
        if (-not $preflight.browser_devtools_ready) { $actions += 'restart_browser_with_remote_debugging_port' }
        if ($preflight.browser_devtools_ready -and -not $preflight.chatgpt_target) { $actions += 'open_or_rebind_chatgpt_target' }
        if (-not $preflight.desktop_agent_heartbeat_fresh) { $actions += 'refresh_desktop_agent_heartbeat' }
    }
    if ($actions.Count -eq 0) { $actions += 'none' }
    return [pscustomobject]@{ ok = $preflight.ok; mode = $preflight.mode; reason = $preflight.reason; actions = $actions; preflight = $preflight } | ConvertTo-Json -Depth 16
}

function Write-DesktopAgentHeartbeat {
    $preflight = Get-DesktopPreflightReport
    $payload = [pscustomobject]@{ last_seen_at = (Get-Date).ToUniversalTime().ToString('o'); session_id = $preflight.current_session_id; mode = $preflight.mode; devtools_ok = $preflight.browser_devtools_ready; chatgpt_target = $preflight.chatgpt_target; reason = $preflight.reason }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $DesktopAgentStateFile -Encoding utf8
    return $payload | ConvertTo-Json -Depth 8
}

