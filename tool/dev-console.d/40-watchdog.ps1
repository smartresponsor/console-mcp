function Invoke-WatchdogPreflight {
    param([string]$Purpose = 'preflight')
    $heal = $null
    try {
        $heal = Invoke-WatchdogHeal | ConvertFrom-Json
    } catch {
        $heal = [pscustomobject]@{
            ok = $false
            status = 'WATCHDOG_HEAL_COMMAND_FAILED'
            error = Sanitize-Text $_.Exception.Message
        }
    }
    $loop = Get-WatchdogLoopProcessState
    $snapshot = Invoke-StackSnapshot -Purpose ("preflight-$Purpose")
    $ok = [bool]($heal.ok -eq $true -and $snapshot.ok -eq $true -and $loop.running -eq $true)
    $preflight = [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'WATCHDOG_PREFLIGHT_GREEN' } else { 'WATCHDOG_PREFLIGHT_RED' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        heal = $heal
        loop = $loop
        snapshot_file = $snapshot.stack_file
    }
    Write-StateArtifact -Directory $WatchdogSnapshotDir -Name (New-StackOperationId -Purpose "preflight-$Purpose") -Payload $preflight | Out-Null
    if (-not $ok) {
        $browser = if ($snapshot -and $snapshot.browser) { $snapshot.browser } else { $null }
        $after = if ($browser -and $browser.after) { $browser.after } else { $null }
        $detail = if ($heal -and $heal.detail) { $heal.detail } else { $null }
        if (Get-Command Invoke-WatchdogAlertIfNeeded -ErrorAction SilentlyContinue) {
            Invoke-WatchdogAlertIfNeeded -Status 'WATCHDOG_PREFLIGHT_RED' -Ok $false -Reason "purpose=$Purpose heal_status=$($heal.status) snapshot_ok=$($snapshot.ok)"
        }
        $localChatgptOk = if ($detail -and $detail.local_chatgpt) { $detail.local_chatgpt.ok } else { $null }
        $publicOk = if ($detail -and $detail.public) { $detail.public.ok } else { $null }
        $tunnelRunning = if ($detail -and $detail.tunnel) { $detail.tunnel.running } else { $null }
        $freshnessOk = if ($detail -and $detail.chatgpt_freshness) { $detail.chatgpt_freshness.ok } else { $null }
        $browserOk = if ($browser) { $browser.ok } else { $null }
        $browserStatus = if ($browser) { $browser.status } else { $null }
        $browserRecoveryAction = if ($browser) { $browser.recovery_action } else { $null }
        $nextAction = if ($after) { $after.next_action } else { $null }
        $markerPresent = if ($after) { [bool]$after.marker } else { $null }
        $edgeProcessCount = if ($after) { $after.microsoft_edge.interactive_process_count } else { $null }
        $cdpOk = if ($after) { $after.cdp_9223.ok } else { $null }
        $chatgptTargetCount = if ($after) { $after.target_inventory.chatgpt_target_count } else { $null }
        throw ("Watchdog preflight failed. heal_ok={0}; heal_status={1}; heal_error={2}; loop_running={3}; snapshot_ok={4}; local_chatgpt_ok={5}; public_ok={6}; tunnel_running={7}; freshness_ok={8}; browser_ok={9}; browser_status={10}; browser_recovery_action={11}; next_action={12}; marker_present={13}; edge_process_count={14}; cdp_ok={15}; chatgpt_target_count={16}" -f ($heal.ok -eq $true), $heal.status, $heal.error, $loop.running, $snapshot.ok, $localChatgptOk, $publicOk, $tunnelRunning, $freshnessOk, $browserOk, $browserStatus, $browserRecoveryAction, $nextAction, $markerPresent, $edgeProcessCount, $cdpOk, $chatgptTargetCount)
    }
    return $preflight
}

# Task Scheduler and the loop's own PID file both consider watchdog-loop-run "running" the moment
# the process exists - neither notices a hang. The broker heartbeat (tool/dev-console.d/85-session-
# relay.ps1, Update-ServerControlBrokerHeartbeat) is written once per second by the loop itself, so
# its age is the only signal that distinguishes "alive" from "alive but stuck". A heartbeat whose
# pid does not match the currently-registered loop pid is treated the same as a stale one: it means
# broker.json is left over from a previous generation that has not yet been overwritten.
#
# Default is 300s, not a tighter value, because the broker heartbeat is only rewritten once per
# *outer* loop iteration in Invoke-WatchdogLoopRun (dev-console.ps1), and that iteration includes
# Invoke-WatchdogCadenceScheduler's repair path (Invoke-WatchdogHeal) when a lane is unhealthy -
# a legitimate single heal can chain Wait-ManagedServiceReady (45s default) twice, plus browser
# recovery and tunnel restarts, well past 30s. A tighter threshold made Start-WatchdogLoop treat an
# in-progress heal as a hang and kill+relaunch the loop mid-repair - confirmed against the live
# broker.json on this machine, which showed >100s gaps between heartbeats from a healthy, still-
# advancing loop. 300s also matches Enter-WatchdogLock's existing lock-freshness window elsewhere
# in dev-console.ps1, and the periodic Scheduled Task safety-net trigger already only re-evaluates
# every 5 minutes, so a shorter default buys no earlier detection there anyway.
function Get-WatchdogLoopHeartbeatMaxAgeSeconds {
    $configured = $env:CONSOLE_MCP_WATCHDOG_HEARTBEAT_MAX_AGE_SECONDS
    $parsed = 0
    if ($configured -and [int]::TryParse($configured, [ref]$parsed) -and $parsed -ge 5 -and $parsed -le 300) {
        return $parsed
    }
    return 300
}

function Get-WatchdogLoopHeartbeatState {
    param([object]$Loop = $null)
    if (-not $Loop) { $Loop = Get-WatchdogLoopProcessState }
    $maxAge = Get-WatchdogLoopHeartbeatMaxAgeSeconds
    $broker = $null
    try { $broker = Get-ServerControlBrokerIdentity } catch { $broker = $null }

    if (-not $broker -or [string]::IsNullOrWhiteSpace([string]$broker.heartbeat_at)) {
        return [pscustomobject]@{ ok = $false; status = 'HEARTBEAT_NEVER_OBSERVED'; age_seconds = $null; max_age_seconds = $maxAge; broker_pid = $null; broker_generation = $null; matches_loop_pid = $false; heartbeat_sequence = $null }
    }

    # [datetime]::Parse() with no explicit styles is culture/kind-ambiguous: on this machine (UTC-5)
    # it was observed to silently treat the 'Z'-suffixed UTC string as local wall-clock time,
    # producing an age off by exactly the local UTC offset (here, ~5 hours) - a heartbeat that was
    # actually seconds old read back as thousands of seconds in the future. Force an unambiguous
    # UTC interpretation instead of relying on ambient culture/kind inference.
    $ageSeconds = $null
    try {
        $heartbeatUtc = [datetime]::Parse(
            [string]$broker.heartbeat_at,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
        )
        $ageSeconds = [Math]::Round(((Get-Date).ToUniversalTime() - $heartbeatUtc).TotalSeconds, 3)
    } catch {
        $ageSeconds = $null
    }
    $matchesLoopPid = [bool]($Loop -and $Loop.pid -and $broker.pid -and [int]$broker.pid -eq [int]$Loop.pid)
    $fresh = [bool]($ageSeconds -ne $null -and $ageSeconds -ge 0 -and $ageSeconds -le $maxAge)

    return [pscustomobject]@{
        ok = [bool]($fresh -and $matchesLoopPid)
        status = if (-not $matchesLoopPid) { 'HEARTBEAT_PID_MISMATCH' } elseif ($fresh) { 'HEARTBEAT_FRESH' } else { 'HEARTBEAT_STALE' }
        age_seconds = $ageSeconds
        max_age_seconds = $maxAge
        broker_pid = $broker.pid
        broker_generation = $broker.generation
        matches_loop_pid = $matchesLoopPid
        heartbeat_sequence = $broker.heartbeat_sequence
    }
}

# Best-effort cause classification for a launch/readiness failure. Ordered from "nothing can work
# until this is fixed" (interactive desktop/autologon) down to "the runtime itself is unhealthy" so
# a caller only ever sees the root cause, not every downstream symptom it produced.
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
    # Automation-only: CDP responding with a live ChatGPT target is what every MCP-tool/engine/CDP
    # consumer actually needs. A missing top-level visible Edge window is a separate, non-blocking
    # human-observability concern (see browser_visible in Get-SystemReadyState) and must not be
    # misclassified here as a browser launch failure - $Browser.ok still folds visible-window state
    # in for the explicitly UI-dependent callers (browser-ensure-visible, browser-relaunch), so this
    # classification cannot reuse it as-is without reintroducing the same false failure.
    $browserAutomationOk = [bool]($Browser -and $Browser.cdp_9223.ok -eq $true -and $Browser.target_inventory.chatgpt_target_count -gt 0)
    if ($Browser -and -not $browserAutomationOk) {
        return [pscustomobject]@{ reason = 'BROWSER_LAUNCH_TIMEOUT'; detail = $Browser; next_action = $Browser.next_action }
    }
    if ($Oauth -and -not $Oauth.ok) {
        return [pscustomobject]@{ reason = 'OAUTH_TIMEOUT'; detail = $Oauth; next_action = 'local chatgpt oauth did not become ready in time; watchdog-heal' }
    }
    return [pscustomobject]@{ reason = 'UNKNOWN'; detail = $null; next_action = 'inspect watchdog-status / system-ready-status for details' }
}

# The single, unified "is the whole console-mcp runtime actually usable" contract. Every earlier
# stage in the startup chain (Task -> launcher -> loop -> browser -> OAuth) previously stopped at
# "I started the next stage"; this is the contract that lets a caller instead confirm "the next
# stage is READY", per the chain-of-custody principle: launch -> wait for readiness -> confirm ->
# hand off, never launch -> hope.
function Get-SystemReadyState {
    $loop = Get-WatchdogLoopProcessState
    $heartbeat = Get-WatchdogLoopHeartbeatState -Loop $loop
    $loopAlive = [bool]($loop.running -and $heartbeat.ok)

    $browser = Get-BrowserStackHealthReport
    # browser_connected is deliberately automation-only (CDP responding + a live ChatGPT CDP target
    # + an active interactive console session). Every real consumer of SYSTEM_READY - MCP tools,
    # the engine, CDP orchestration - only needs the browser to be automatable, not visible on a
    # physical screen. Requiring a visible top-level window (MainWindowHandle != 0) here was
    # architecturally fragile: a minimized Edge, a window on another virtual desktop, a hidden/
    # background window, or a transient Windows window-enumeration race all legitimately produce
    # zero visible windows while automation keeps working, and used to flip the whole system to
    # SYSTEM_NOT_READY for it. Visible-window state is still tracked - see the non-blocking
    # browser_visible field below - and commands that genuinely need a human-visible window
    # (browser-ensure-visible, browser-relaunch-visible) keep enforcing it via
    # Get-BrowserStackHealthReport.ok / .next_action, which are unchanged.
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
    # /mcp responding 401 with WWW-Authenticate is the MCP-over-HTTP protocol handshake for an
    # unauthenticated caller; it is what proves the endpoint is a live MCP server, not just an open
    # TCP port (see Invoke-ChatgptSmoke's mcp_unauthorized field).
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

    # Informational only - deliberately not a key inside $checks, so it can never affect $notReady/
    # $ok. repair_required stays false by default: a missing visible window is not, by itself, a
    # reason to run any repair action against a SYSTEM_READY (automation-usable) stack.
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

# Show-WatchdogTask already computes declaration drift (Compare-WatchdogTaskDeclaration) but only
# ever reported it - repairing was a manual "run install-watchdog-task" step. Register-ScheduledTask
# -Force (inside Install-WatchdogTask) is already idempotent update-in-place, so re-running it here
# is safe: it never deletes/recreates the task, just rewrites its declaration to match canonical.
function Invoke-ScheduledTaskDeclarationSelfHeal {
    $before = Show-WatchdogTask | ConvertFrom-Json
    if (-not $before.exists) {
        Install-WatchdogTask | Out-Null
        return [pscustomobject]@{ ok = $true; action_taken = 'installed_missing_task'; before = $before; after = (Show-WatchdogTask | ConvertFrom-Json) }
    }
    if (-not $before.declaration.ok) {
        Install-WatchdogTask | Out-Null
        $after = Show-WatchdogTask | ConvertFrom-Json
        return [pscustomobject]@{ ok = [bool]$after.declaration.ok; action_taken = 'reinstalled_drifted_task'; drift = $before.declaration.drift; before = $before; after = $after }
    }
    return [pscustomobject]@{ ok = $true; action_taken = 'none'; before = $before; after = $before }
}

# Replaces "Task Scheduler ran once, LastTaskResult was captured, done" with "keep trying, within
# bounds, until SYSTEM_READY is actually true". Bounded on two axes: MaxAttempts (never infinite)
# and Start-WatchdogLoop's own internal poll deadlines (never an unconditional wait). Intended both
# as an on-demand command and as what a future scheduled verification trigger would call.
function Invoke-WatchdogVerifyAndHeal {
    param(
        [int]$MaxAttempts = 3,
        [int]$SettleSeconds = 10
    )

    $taskHeal = $null
    try {
        $taskHeal = Invoke-ScheduledTaskDeclarationSelfHeal
    } catch {
        $taskHeal = [pscustomobject]@{ ok = $false; action_taken = 'failed'; error = Sanitize-Text $_.Exception.Message }
    }

    $attempts = [System.Collections.Generic.List[object]]::new()
    $ready = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $launch = $null
        try { $launch = Start-WatchdogLoop | ConvertFrom-Json } catch { $launch = [pscustomobject]@{ ok = $false; error = Sanitize-Text $_.Exception.Message } }
        Start-Sleep -Seconds $SettleSeconds
        $ready = Get-SystemReadyState
        $attempts.Add([pscustomobject]@{ attempt = $attempt; launch = $launch; ok = $ready.ok; status = $ready.status; not_ready = $ready.not_ready; failure_classification = $ready.failure_classification }) | Out-Null
        if ($ready.ok) { break }
    }

    $ok = [bool]($ready -and $ready.ok)
    $status = if ($ok) { 'VERIFY_AND_HEAL_READY' } else { 'VERIFY_AND_HEAL_EXHAUSTED' }
    if (-not $ok) {
        $reasonText = "system not ready after $MaxAttempts attempts; not_ready=$(($ready.not_ready) -join ','); failure_reason=$($ready.failure_classification.reason)"
        if (Get-Command Invoke-WatchdogAlertIfNeeded -ErrorAction SilentlyContinue) {
            Invoke-WatchdogAlertIfNeeded -Status $status -Ok $false -Reason $reasonText
        }
    }
    Write-WatchdogState -Status $status -Ok $ok -Actions @([pscustomobject]@{ action = 'watchdog-verify-and-heal'; reason = 'bounded end-to-end SYSTEM_READY verification with retry'; task_heal = $taskHeal }) -Detail ([pscustomobject]@{ task_heal = $taskHeal; attempts = @($attempts); system_ready = $ready }) | Out-Null

    return [pscustomobject]@{
        ok = $ok
        status = $status
        max_attempts = $MaxAttempts
        settle_seconds = $SettleSeconds
        task_heal = $taskHeal
        attempts = @($attempts)
        system_ready = $ready
        next_action = if ($ok) { 'none' } else { 'manual intervention required: full Scheduled Task unregister/recreate was deliberately not attempted automatically (risk of racing a concurrently-running task instance or a caller mid Start-ScheduledTask); inspect failure_classification, then repair the underlying cause and re-run watchdog-verify-and-heal' }
    }
}

Set-Variable -Name DevConsoleWatchdogModuleLoaded -Scope Script -Value $true -Force
