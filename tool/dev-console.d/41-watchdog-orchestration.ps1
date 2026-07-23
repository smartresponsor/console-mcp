function Invoke-WatchdogHeal {
    $retention = Invoke-VarRetentionIfDue
    $actions = @()
    if ($retention) {
        $actions += [pscustomobject]@{ action = 'var-retention-prune'; reason = 'periodic diagnostic-artifact retention'; results = $retention.results }
    }
    $autologon = Get-AutologonReport
    $consoleSession = Get-ConsoleSessionReport
    if (-not $autologon.ok) {
        $actions += [pscustomobject]@{ action = 'check-autologon'; reason = 'visible browser recovery depends on Windows autologon'; status = $autologon.status; ok = $autologon.ok; reasons = $autologon.reasons }
    }
    if (-not $consoleSession.ok) {
        $actions += [pscustomobject]@{ action = 'check-console-session'; reason = 'visible browser recovery depends on active desktop console session'; status = $consoleSession.status; ok = $consoleSession.ok; reasons = $consoleSession.reasons; active_console = $consoleSession.active_console }
    }
    $chatgptRuntimeRestarted = $false
    $browserRecovery = $null
    $locked = Enter-WatchdogLock
    if (-not $locked) {
        return (Write-WatchdogState -Status 'SKIPPED_LOCKED' -Ok $true -Actions @([pscustomobject]@{ action = 'skip'; reason = 'fresh watchdog lock exists' }) | ConvertTo-Json -Depth 20)
    }

    try {
        $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        if (-not $chatgptState.running -or -not $chatgptState.port_open -or $localChatgpt.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'start-chatgpt-oauth'; reason = 'local chatgpt oauth was not ready' }
            $chatgptRuntimeRestarted = $true
            Start-ChatgptOauth | Out-Null
            Wait-ManagedServiceReady -Spec (Get-ChatgptSpec) -Origin $ChatgptOrigin -Kind 'chatgpt' | Out-Null
        }

        $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $localCodex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        if (-not $codexState.running -or -not $codexState.port_open -or $localCodex.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'replace-unified-runtime'; reason = 'local codex bearer was not ready or token mismatch detected' }
            Stop-UnifiedConsoleRuntime | Out-Null
            Start-CodexBearer | Out-Null
            Wait-ManagedServiceReady -Spec (Get-CodexSpec) -Origin $CodexOrigin -Kind 'codex' -ExpectedTools (Get-DefaultExpectedSurface) | Out-Null
        }

        $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $freshness = Get-ChatgptRuntimeFreshness
        $runtimeReplacePlan = New-ConsoleDevRuntimeReplacePlan
        if ($runtimeReplacePlan.safe_to_execute -eq $true) {
            $actions += [pscustomobject]@{ action = 'runtime-replace-stale'; reason = 'typed runtime replace plan proved chatgpt oauth stale'; freshness = $freshness; runtime_replace_plan = $runtimeReplacePlan }
            $chatgptRuntimeRestarted = $true
            Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools (Get-DefaultExpectedSurface) | Out-Null
            $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
            $freshness = Get-ChatgptRuntimeFreshness
        } elseif ($localChatgpt.ok -eq $true -and $freshness.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'runtime-replace-stale-blocked'; reason = 'typed runtime replace plan did not allow restart'; freshness = $freshness; runtime_replace_plan = $runtimeReplacePlan; ok = $false }
        }

        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            $actions += [pscustomobject]@{ action = 'start-tunnel'; reason = 'cloudflared tunnel was not running' }
            Start-Tunnel | Out-Null
        }

        $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        $mobileEdge = Invoke-MobileEdgeWatchdogHeal
        $actions += [pscustomobject]@{ action = 'mobile-edge-health'; reason = 'Mobiling mobile-edge should be live for mobile app/API work'; status = $mobileEdge.status; ok = $mobileEdge.ok; action_taken = $mobileEdge.action_taken }
        try {
            $browserRecovery = Invoke-BrowserEnsureVisible -Purpose 'watchdog-heal' -PassThroughFailure
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight'; status = $browserRecovery.status; ok = $browserRecovery.ok; recovery_action = $browserRecovery.recovery_action }
        } catch {
            $browserRecovery = [pscustomobject]@{ ok = $false; status = 'BROWSER_RECOVERY_FAILED'; error = Sanitize-Text $_.Exception.Message }
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight failed'; status = $browserRecovery.status; ok = $false; error = $browserRecovery.error }
        }
        if ($public.ok -ne $true -and $localChatgpt.ok -eq $true) {
            $actions += [pscustomobject]@{ action = 'restart-tunnel'; reason = 'public smoke failed while local chatgpt was ready' }
            Stop-Tunnel | Out-Null
            Start-Tunnel | Out-Null
        } elseif ($public.ok -ne $true -and $localChatgpt.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'recover-chatgpt-before-public'; reason = 'both local and public chatgpt smoke failed' }
            Start-ChatgptOauth | Out-Null
            Wait-ManagedServiceReady -Spec (Get-ChatgptSpec) -Origin $ChatgptOrigin -Kind 'chatgpt' | Out-Null
        }

        $finalChatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        $finalChatgptFreshness = Get-ChatgptRuntimeFreshness
        $finalTunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        $finalCodexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $finalLocalChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $finalLocalCodex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        $finalPublic = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        $connectorRefresh = $null
        $browserOk = [bool]($browserRecovery -and $browserRecovery.ok -eq $true)
        $browserSessionBlocked = [bool]($browserRecovery -and $browserRecovery.desktop_boundary -and $browserRecovery.desktop_boundary.blocked -eq $true)
        if ($chatgptRuntimeRestarted -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $finalPublic.ok -eq $true) {
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
            $actions += [pscustomobject]@{ action = 'connector-schema-propagation'; reason = 'runtime was rebuilt/replaced; ChatGPT must refresh and fetch the matching schema'; refresh_status = $connectorRefresh.status; refresh_ok = $connectorRefresh.ok; schema_propagation = $connectorRefresh.schema_propagation }
        }
        $codexOk = [bool]($finalCodexState.running -and $finalCodexState.port_open -and $finalLocalCodex.ok -eq $true)
        # Server recovery (chatgpt/codex/tunnel/public/mobile-edge) is the required, SSH-safe half of
        # watchdog health. Browser-visible recovery is best-effort: when it fails solely because this
        # process is outside the interactive desktop session (SSH/session-0), that is an expected,
        # non-actionable limitation, not a stack failure, so it must not flip the overall status to FAILED.
        $schemaPropagationOk = [bool](-not $chatgptRuntimeRestarted -or (Test-ChatgptConnectorRefreshAcceptable -Result $connectorRefresh))
        # Mobile-edge is observed and repaired opportunistically, but it is not part of the
        # console-mcp server ownership boundary and cannot make server/watchdog replacement fail.
        $serverOk = [bool]($finalChatgptState.running -and $finalChatgptState.port_open -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $codexOk -and $finalTunnelState.running -and $finalPublic.ok -eq $true -and $schemaPropagationOk)
        $ok = [bool]($serverOk -and ($browserOk -or $browserSessionBlocked))
        $status = if ($chatgptRuntimeRestarted -and -not $schemaPropagationOk) { 'FAILED_CONNECTOR_SCHEMA_PROPAGATION_UNCONFIRMED' } elseif ($ok -and $browserOk -and $actions.Count -gt 0) { 'HEALED' } elseif ($ok -and $browserOk) { 'HEALTHY' } elseif ($ok -and $browserSessionBlocked) { 'DEGRADED_BROWSER_RECOVERY_UNAVAILABLE' } elseif ($finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -ne $true) { 'FAILED_STALE_RUNTIME_NOT_REPLACED' } else { 'FAILED' }
        Invoke-WatchdogAlertIfNeeded -Status $status -Ok ([bool]$ok) -Reason $status
        return (Write-WatchdogState -Status $status -Ok ([bool]$ok) -Actions $actions -Detail @{ autologon = $autologon; console_session = $consoleSession; chatgpt_oauth = $finalChatgptState; chatgpt_freshness = $finalChatgptFreshness; codex_bearer = $finalCodexState; local_codex = $finalLocalCodex; tunnel = $finalTunnelState; local_chatgpt = $finalLocalChatgpt; public = $finalPublic; browser = $browserRecovery; server_recovery = [pscustomobject]@{ ok = $serverOk }; mobile_edge = $mobileEdge; connector_refresh = $connectorRefresh } | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Invoke-WatchdogAlertIfNeeded -Status 'FAILED' -Ok $false -Reason $message
        return (Write-WatchdogState -Status 'FAILED' -Ok $false -Actions $actions -ErrorMessage $message | ConvertTo-Json -Depth 20)
    } finally {
        Exit-WatchdogLock
    }
}

function Get-TunnelSpec {
    return [pscustomobject]@{
        Name = 'cloudflared-console-mcp'
        PidFile = $TunnelPidFile
        LogFile = $TunnelLogFile
        ConfigFile = $CloudflaredConfig
        Matcher = '(?i)cloudflared\b.*\btunnel\b.*\brun\s+console-mcp\b'
        UseMatcherFallback = $true
    }
}

function Get-RestartAllPlan {
    $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $build = Get-BuildOutputReport
    $freshness = Get-ChatgptRuntimeFreshness
    $browser = Get-BrowserStackHealthReport
    $blocked = @()
    if ($build.build_needed) { $blocked += 'build_output_stale' }
    if ($chatgpt.port_conflict -or $codex.port_conflict) { $blocked += 'port_conflict' }
    if ($browser.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED') { $blocked += 'interactive_browser_recovery_required' }
    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RESTART_ALL_PLAN_READY' } else { 'RESTART_ALL_PLAN_BLOCKED' }
        command = 'restart-all'
        mode = 'warm'
        will_stop_anything = $false
        target_profiles = @('chatgpt-oauth', 'codex-bearer', 'tunnel')
        safe_to_execute = $safe
        reason = if ($safe) { 'preflight_ready' } else { 'preflight_blocked' }
        blocked_reasons = $blocked
        build_output = $build
        freshness = $freshness
        services = [pscustomobject]@{
            chatgpt_oauth = $chatgpt
            codex_bearer = $codex
            tunnel = $tunnel
        }
        browser = $browser
        restart = Get-RestartState
        next_action = if ($safe) { 'run restart-all only if a broad stack restart is explicitly intended' } else { 'inspect blockers before restart-all' }
    } | ConvertTo-Json -Depth 30
}

function Get-RuntimeReplaceState {
    if (-not (Test-Path -LiteralPath $RuntimeReplaceStateFile -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $RuntimeReplaceStateFile -Raw | ConvertFrom-Json -Depth 20)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'RUNTIME_REPLACE_STATE_UNREADABLE'
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Write-RuntimeReplaceState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object]$Plan = $null,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )
    Ensure-Directories
    $state = [pscustomobject]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        state_file = $RuntimeReplaceStateFile
        plan = $Plan
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $RuntimeReplaceStateFile -Encoding utf8
    Write-ServerLifecycleEvent -Operation 'runtime-replace' -Mode 'warm' -Scope 'chatgpt' -Phase $Status -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return $state
}

function New-ConsoleDevRuntimeReplacePlan {
    param(
        [ValidateSet('chatgpt')][string]$Kind = 'chatgpt',
        [ValidateSet('warm')][string]$Mode = 'warm',
        [int]$CooldownSeconds = 90
    )
    $spec = Get-ChatgptSpec
    $service = Get-ManagedProcessState -Spec $spec
    $freshness = Get-ChatgptRuntimeFreshness
    $local = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $build = Get-BuildOutputReport
    $last = Get-RuntimeReplaceState
    $blocked = @()
    $staleProof = @()

    foreach ($reason in @($freshness.reasons)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$reason)) { $staleProof += [string]$reason }
    }
    if ($freshness.status -eq 'STALE' -and $staleProof.Count -eq 0) { $staleProof += 'runtime_stale' }

    if ($service.port_conflict) { $blocked += 'foreign_listener_or_port_conflict' }
    if (-not $service.running) { $blocked += 'target_runtime_not_running' }
    if (-not $service.port_open) { $blocked += 'target_port_not_open' }
    if ($local.ok -ne $true) { $blocked += 'local_runtime_not_healthy' }
    if ($freshness.ok -eq $true) { $blocked += 'runtime_already_current' }
    if ($staleProof.Count -eq 0) { $blocked += 'missing_explicit_stale_proof' }

    $lastAt = $null
    if ($last -and $last.at) {
        try { $lastAt = [datetime]::Parse([string]$last.at).ToUniversalTime() } catch { $lastAt = $null }
    }
    $lastAgeSeconds = if ($lastAt) { [Math]::Round(((Get-Date).ToUniversalTime() - $lastAt).TotalSeconds, 3) } else { $null }
    if ($lastAgeSeconds -ne $null -and $lastAgeSeconds -lt $CooldownSeconds -and $freshness.ok -ne $true) {
        $blocked += 'cooldown_active_after_recent_replace'
    }

    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RUNTIME_REPLACE_PLAN_READY' } else { 'RUNTIME_REPLACE_PLAN_BLOCKED' }
        command = 'runtime-replace-stale'
        mode = $Mode
        will_stop_anything = $safe
        target_profiles = @($spec.Name)
        reason = if ($safe) { 'stale_runtime_proven' } else { 'precondition_blocked' }
        safe_to_execute = $safe
        stale_proof = @($staleProof)
        blocked_reasons = @($blocked | Sort-Object -Unique)
        cooldown_seconds = $CooldownSeconds
        last_replace_age_seconds = $lastAgeSeconds
        service = $service
        freshness = $freshness
        local = $local
        build_output = $build
        last_replace = $last
        next_action = if ($safe) { 'run runtime-replace-stale to replace only chatgpt-oauth' } else { 'do not stop runtime; inspect blocked_reasons' }
    }
}

function Assert-ConsoleDevRuntimeReplacePrerequisiteShape {
    param([Parameter(Mandatory = $true)]$Plan)
    $targets = @($Plan.target_profiles)
    if ($targets.Count -ne 1 -or $targets[0] -ne 'chatgpt-oauth') {
        throw 'Runtime replace plan must target only chatgpt-oauth.'
    }
    if ($Plan.safe_to_execute -eq $true -and @($Plan.stale_proof).Count -eq 0) {
        throw 'Runtime replace plan cannot execute without explicit stale proof.'
    }
    if ($Plan.safe_to_execute -eq $true -and $Plan.will_stop_anything -ne $true) {
        throw 'Executable runtime replace plan must disclose will_stop_anything=true.'
    }
    return $Plan
}

function Invoke-ConsoleDevRuntimeReplaceStale {
    $plan = Assert-ConsoleDevRuntimeReplacePrerequisiteShape -Plan (New-ConsoleDevRuntimeReplacePlan)
    if ($plan.safe_to_execute -ne $true) {
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_BLOCKED' -Ok $false -Plan $plan -Detail @{ blocked_reasons = $plan.blocked_reasons }
        return ($state | ConvertTo-Json -Depth 30)
    }

    Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_REPLACING' -Ok $false -Plan $plan | Out-Null
    try {
        $result = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools @()
        $postcondition = Invoke-AuthRuntimePostcondition -Kind 'chatgpt'
        $ok = [bool]($postcondition.ok -eq $true)
        $replaceStatus = if ($ok) { 'RUNTIME_REPLACE_READY' } else { 'RUNTIME_REPLACE_POSTCONDITION_FAILED' }
        $state = Write-RuntimeReplaceState -Status $replaceStatus -Ok $ok -Plan $plan -Detail @{ restart = $result; postcondition = $postcondition }
        return ($state | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_FAILED' -Ok $false -Plan $plan -ErrorMessage $message
        return ($state | ConvertTo-Json -Depth 30)
    }
}

