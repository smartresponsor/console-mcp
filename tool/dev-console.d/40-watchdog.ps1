function Write-ServerLaunchWatchdogState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [object]$Detail = $null
    )

    $autologon = Get-AutologonReport
    $consoleSession = Get-ConsoleSessionReport
    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $chatgptFreshness = Get-ChatgptRuntimeFreshness
    $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
    $browser = Get-BrowserStackHealthReport
    $ok = [bool]($autologon.ok -and $consoleSession.ok -and $chatgptState.running -and $chatgptState.port_open -and $chatgptFreshness.ok -and $tunnelState.running -and $localChatgpt.ok -and $public.ok -and $browser.ok)
    $actions = @([pscustomobject]@{ action = 'server-launch-watchdog-state-refresh'; reason = 'server launch completed and watchdog state must reflect current contracts'; ok = $ok })
    return Write-WatchdogState -Status $Status -Ok $ok -Actions $actions -Detail @{ autologon = $autologon; console_session = $consoleSession; chatgpt_oauth = $chatgptState; chatgpt_freshness = $chatgptFreshness; tunnel = $tunnelState; local_chatgpt = $localChatgpt; public = $public; browser = $browser; launch = $Detail }
}

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
