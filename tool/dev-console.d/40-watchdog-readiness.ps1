function Get-WatchdogLaunchFailureClassification {
    param(
        [object]$ConsoleSession = $null,
        [object]$Autologon = $null,
        [object]$Browser = $null,
        [object]$Loop = $null,
        [object]$Heartbeat = $null,
        [object]$Oauth = $null
    )

    if (-not $ConsoleSession) { $ConsoleSession = Get-ConsoleSessionReport }
    if (-not $Autologon) { $Autologon = Get-AutologonReport }
    if (-not $Loop) { $Loop = Get-WatchdogLoopProcessState }
    if (-not $Heartbeat) { $Heartbeat = Get-WatchdogLoopHeartbeatState -Loop $Loop }
    if (-not $Browser) { $Browser = Get-BrowserStackHealthReport }

    $edgeProfileLocked = $false
    $edgeProfileLockPath = $null
    try {
        $markerFile = Join-Path (Split-Path -Parent $Root) 'browser\log\startup-edge-marker.txt'
        if (Test-Path -LiteralPath $markerFile -PathType Leaf) {
            $markerJson = (Get-Content -LiteralPath $markerFile -Raw).Trim() | ConvertFrom-Json
            if ($markerJson.profile_dir) {
                $edgeProfileLockPath = Join-Path ([string]$markerJson.profile_dir) 'SingletonLock'
                $edgeProfileLocked = Test-Path -LiteralPath $edgeProfileLockPath
            }
        }
    } catch {
        $edgeProfileLocked = $false
    }

    if (-not $ConsoleSession.ok) {
        return [pscustomobject]@{ reason = 'INTERACTIVE_DESKTOP_UNAVAILABLE'; detail = $ConsoleSession.reasons; next_action = 'no active interactive console session for this user; check-console-session / desktop-relogin' }
    }
    if (-not $Autologon.ok) {
        return [pscustomobject]@{ reason = 'INTERACTIVE_DESKTOP_UNAVAILABLE'; detail = $Autologon.reasons; next_action = 'Windows autologon is not configured correctly; repair so the interactive session survives reboot' }
    }
    if (-not $Loop -or -not $Loop.running) {
        return [pscustomobject]@{ reason = 'LOOP_EXITED_UNEXPECTEDLY'; detail = [pscustomobject]@{ pid_file = $Loop.pid_file; stale_pid_file = $Loop.stale_pid_file }; next_action = 'inspect console-mcp-watchdog-loop log/state file for the exception that ended the loop, then start-watchdog-loop' }
    }
    if ($Heartbeat -and -not $Heartbeat.ok) {
        return [pscustomobject]@{ reason = 'WATCHDOG_INIT_FAILED'; detail = $Heartbeat; next_action = 'watchdog-loop-run process is alive but never produced a matching fresh heartbeat; restart-watchdog-loop' }
    }
    if ($edgeProfileLocked) {
        return [pscustomobject]@{ reason = 'EDGE_PROFILE_LOCKED'; detail = [pscustomobject]@{ lock_path = $edgeProfileLockPath }; next_action = 'close any orphaned msedge.exe holding the profile, or remove the stale SingletonLock file, then browser-relaunch-visible' }
    }
    $browserAutomationOk = [bool]($Browser -and $Browser.cdp_9223.ok -eq $true -and $Browser.target_inventory.chatgpt_target_count -gt 0)
    if ($Browser -and -not $browserAutomationOk) {
        return [pscustomobject]@{ reason = 'BROWSER_LAUNCH_TIMEOUT'; detail = $Browser; next_action = $Browser.next_action }
    }
    if ($Oauth -and -not $Oauth.ok) {
        return [pscustomobject]@{ reason = 'OAUTH_TIMEOUT'; detail = $Oauth; next_action = 'local chatgpt oauth did not become ready in time; watchdog-heal' }
    }
    return [pscustomobject]@{ reason = 'UNKNOWN'; detail = $null; next_action = 'inspect watchdog-status / system-ready-status for details' }
}

function Get-SystemReadyState {
    $loop = Get-WatchdogLoopProcessState
    $heartbeat = Get-WatchdogLoopHeartbeatState -Loop $loop
    $loopAlive = [bool]($loop.running -and $heartbeat.ok)

    $browser = Get-BrowserStackHealthReport
    $browserCdpOk = [bool]($browser.cdp_9223.ok -eq $true)
    $browserChatgptTargetOk = [bool]($browser.target_inventory.chatgpt_target_count -gt 0)
    $browserActiveConsoleOk = [bool]($browser.active_console.has_active_console -eq $true)
    $browserConnected = [bool]($browserCdpOk -and $browserChatgptTargetOk -and $browserActiveConsoleOk)
    $browserConnectedNextAction = if ($browserConnected) {
        'none'
    } elseif (-not $browserCdpOk) {
        'CDP_RECOVERY_REQUIRED'
    } elseif (-not $browserChatgptTargetOk) {
        'CHATGPT_VISIBLE_PAGE_REQUIRED'
    } else {
        'INTERACTIVE_CONSOLE_SESSION_REQUIRED'
    }
    $browserVisibleOk = [bool]($browser.microsoft_edge.visible_window_detected -eq $true)

    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $oauthReady = [bool]($chatgptState.running -and $chatgptState.port_open -and $localChatgpt.ok -eq $true)
    $portResponding = [bool]($chatgptState.port_open -and $localChatgpt.metadata_ok -eq $true)
    $mcpHandshake = [bool]($localChatgpt.mcp_unauthorized -eq $true)

    $checks = [ordered]@{
        loop_alive = [pscustomobject]@{ ok = $loopAlive; running = [bool]$loop.running; pid = $loop.pid; heartbeat = $heartbeat }
        browser_connected = [pscustomobject]@{
            ok = $browserConnected
            status = if ($browserConnected) { 'BROWSER_AUTOMATION_READY' } else { 'BROWSER_AUTOMATION_NOT_READY' }
            next_action = $browserConnectedNextAction
            cdp_ok = $browserCdpOk
            chatgpt_target_count = $browser.target_inventory.chatgpt_target_count
            has_active_console = $browserActiveConsoleOk
        }
        oauth_ready = [pscustomobject]@{ ok = $oauthReady; process = $chatgptState; smoke = $localChatgpt }
        port_responding = [pscustomobject]@{ ok = $portResponding; origin = $ChatgptOrigin }
        mcp_handshake = [pscustomobject]@{ ok = $mcpHandshake; mcp_status = $localChatgpt.mcp_status }
    }

    $notReady = @($checks.Keys | Where-Object { -not $checks[$_].ok })
    $ok = [bool]($notReady.Count -eq 0)
    $classification = $null
    if (-not $ok) {
        $classification = Get-WatchdogLaunchFailureClassification -Loop $loop -Heartbeat $heartbeat -Browser $browser -Oauth ([pscustomobject]@{ ok = $oauthReady })
    }

    $browserVisible = [pscustomobject]@{
        ok = $browserVisibleOk
        status = if ($browserVisibleOk) { 'EDGE_WINDOW_VISIBLE' } else { 'EDGE_WINDOW_NOT_VISIBLE' }
        repair_required = $false
        visible_window_count = $browser.microsoft_edge.visible_window_count
        detected_via = if ($browser.microsoft_edge.local_visible_window_detected) { 'local' } elseif ($browser.microsoft_edge.desktop_snapshot_visible_detected) { 'desktop_snapshot' } else { 'none' }
    }

    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'SYSTEM_READY' } else { 'SYSTEM_NOT_READY' }
        at = (Get-Date).ToUniversalTime().ToString('o')
        not_ready = @($notReady)
        checks = [pscustomobject]$checks
        browser_visible = $browserVisible
        failure_classification = $classification
    }
}

