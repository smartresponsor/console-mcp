function Get-PublicTunnelDiagnosticSnapshot {
    param([ValidateRange(1, 200)][int]$TailLines = 80)

    $lines = @()
    if (Test-Path -LiteralPath $TunnelLogFile -PathType Leaf) {
        try { $lines = @(Get-Content -LiteralPath $TunnelLogFile -Tail $TailLines -ErrorAction Stop) } catch { $lines = @() }
    }
    $text = ($lines -join [Environment]::NewLine)
    $classification = if ($text -match '(?i)quic|datagram|udp') {
        'QUIC_OR_UDP'
    } elseif ($text -match '(?i)http/2|http2') {
        'HTTP2'
    } elseif ($text -match '(?i)dns|lookup|resolve') {
        'DNS'
    } elseif ($text -match '(?i)timeout|timed out|deadline') {
        'TIMEOUT'
    } elseif ($text -match '(?i)connection reset|connection closed|broken pipe|disconnect') {
        'CONNECTION_RESET'
    } elseif ($text -match '(?i)refused|origin.*unreachable|unable to reach') {
        'ORIGIN_UNREACHABLE'
    } elseif ($text -match '(?i)error|failed|failure') {
        'OTHER_ERROR'
    } else {
        'UNCLASSIFIED'
    }

    return [pscustomobject]@{
        captured_at = (Get-Date).ToString('o')
        log_file = $TunnelLogFile
        log_exists = (Test-Path -LiteralPath $TunnelLogFile -PathType Leaf)
        tail_line_count = $lines.Count
        classification = $classification
        tail = @($lines | ForEach-Object { Sanitize-Text ([string]$_) })
    }
}

function Invoke-PublicTunnelFastRecovery {
    param(
        [ValidateRange(0, 10)][int]$RetryDelaySeconds = 2,
        [ValidateRange(1, 10)][int]$StableSuccessCount = 3
    )

    $local = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $first = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
    if ($first.ok -eq $true) {
        return [pscustomobject]@{
            ok = $true
            status = 'PUBLIC_TUNNEL_HEALTHY'
            repair_required = $false
            action_taken = 'none'
            local = $local
            first_probe = $first
            second_probe = $null
            diagnostic = $null
            verified = $first
        }
    }

    if ($RetryDelaySeconds -gt 0) { Start-Sleep -Seconds $RetryDelaySeconds }
    $second = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public-retry' -Quiet
    if ($second.ok -eq $true) {
        return [pscustomobject]@{
            ok = $true
            status = 'PUBLIC_TUNNEL_TRANSIENT_FAILURE_RECOVERED'
            repair_required = $false
            action_taken = 'none'
            local = $local
            first_probe = $first
            second_probe = $second
            diagnostic = $null
            verified = $second
        }
    }

    $diagnostic = Get-PublicTunnelDiagnosticSnapshot
    if ($local.ok -ne $true) {
        return [pscustomobject]@{
            ok = $false
            status = 'PUBLIC_TUNNEL_FAILURE_WITH_LOCAL_FAILURE'
            repair_required = $true
            action_taken = 'defer_to_full_heal'
            local = $local
            first_probe = $first
            second_probe = $second
            diagnostic = $diagnostic
            verified = $null
        }
    }

    Stop-Tunnel | Out-Null
    Start-Tunnel | Out-Null
    $verified = Wait-PublicSmokeReady -TimeoutSeconds 20 -IntervalSeconds 1 -StableSuccessCount $StableSuccessCount
    return [pscustomobject]@{
        ok = [bool]($verified.ok -eq $true)
        status = if ($verified.ok -eq $true) { 'PUBLIC_TUNNEL_RESTART_VERIFIED' } else { 'PUBLIC_TUNNEL_RESTART_UNVERIFIED' }
        repair_required = [bool]($verified.ok -ne $true)
        action_taken = 'restart_tunnel'
        local = $local
        first_probe = $first
        second_probe = $second
        diagnostic = $diagnostic
        verified = $verified
    }
}

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

        $publicRecovery = Invoke-PublicTunnelFastRecovery
        $public = $publicRecovery.verified
        if (-not $public) { $public = $publicRecovery.second_probe }
        if (-not $public) { $public = $publicRecovery.first_probe }
        if ($publicRecovery.action_taken -ne 'none') {
            $actions += [pscustomobject]@{
                action = $publicRecovery.action_taken
                reason = $publicRecovery.status
                diagnostic = $publicRecovery.diagnostic
            }
        }
        $mobileEdge = Invoke-MobileEdgeWatchdogHeal
        $actions += [pscustomobject]@{ action = 'mobile-edge-health'; reason = 'Mobiling mobile-edge should be live for mobile app/API work'; status = $mobileEdge.status; ok = $mobileEdge.ok; action_taken = $mobileEdge.action_taken }
        $visualGallery = Invoke-VisualGalleryWatchdogHeal
        $actions += [pscustomobject]@{ action = 'visual-gallery-health'; reason = 'visual artifacts should remain available independently of CMCP Go'; status = $visualGallery.status; ok = $visualGallery.ok; action_taken = $visualGallery.action_taken; gallery_url = $visualGallery.after.gallery_url }
        try {
            $browserRecovery = Invoke-BrowserEnsureVisible -Purpose 'watchdog-heal' -PassThroughFailure
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight'; status = $browserRecovery.status; ok = $browserRecovery.ok; recovery_action = $browserRecovery.recovery_action }
        } catch {
            $browserRecovery = [pscustomobject]@{ ok = $false; status = 'BROWSER_RECOVERY_FAILED'; error = Sanitize-Text $_.Exception.Message }
            $actions += [pscustomobject]@{ action = 'browser-ensure-visible'; reason = 'watchdog browser chain preflight failed'; status = $browserRecovery.status; ok = $false; error = $browserRecovery.error }
        }
        if ($public.ok -ne $true -and $localChatgpt.ok -ne $true) {
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
        return (Write-WatchdogState -Status $status -Ok ([bool]$ok) -Actions $actions -Detail @{ autologon = $autologon; console_session = $consoleSession; chatgpt_oauth = $finalChatgptState; chatgpt_freshness = $finalChatgptFreshness; codex_bearer = $finalCodexState; local_codex = $finalLocalCodex; tunnel = $finalTunnelState; local_chatgpt = $finalLocalChatgpt; public = $finalPublic; public_tunnel_recovery = $publicRecovery; browser = $browserRecovery; server_recovery = [pscustomobject]@{ ok = $serverOk }; mobile_edge = $mobileEdge; visual_gallery = $visualGallery; connector_refresh = $connectorRefresh } | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Invoke-WatchdogAlertIfNeeded -Status 'FAILED' -Ok $false -Reason $message
        return (Write-WatchdogState -Status 'FAILED' -Ok $false -Actions $actions -ErrorMessage $message | ConvertTo-Json -Depth 20)
    } finally {
        Exit-WatchdogLock
    }
}

