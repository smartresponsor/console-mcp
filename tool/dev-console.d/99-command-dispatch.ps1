# CLI command dispatch is owned here; command implementations remain in their domain modules.
function Invoke-DevConsoleCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$EngineArgs = @()
    )

switch ($Command) {
    'status' { Show-Status }
    'start-server' {
        # Session-safe: relayed to the Task-Scheduler-bound watchdog loop regardless of which
        # session issued this command. See tool/dev-console.d/85-session-relay.ps1.
        $response = Request-ServerControlAction -Action 'start-server'
        $response | ConvertTo-Json -Depth 40
        if (-not $response.result.ok) { exit 1 }
    }
    'stop-server' {
        # Compatibility shutdown/replacement route. The authoritative implementation currently
        # replaces the unified runtime and verifies the new process; prefer restart-server when
        # replacement is the user's explicit intent.
        $response = Request-ServerControlAction -Action 'stop-server'
        $response | ConvertTo-Json -Depth 40
        if (-not $response.result.ok) { exit 1 }
    }
    'restart-server' {
        $checkOnly = @($EngineArgs) -contains '--check'
        $diagnostic = @($EngineArgs) -contains '--diagnostic'
        $response = if ($checkOnly) { Invoke-RestartPreflight -Diagnostic:$diagnostic } else { Invoke-FailSafeRestart -Diagnostic:$diagnostic }
        $response | ConvertTo-Json -Depth 50
        if (-not $response.ok) { exit 1 }
    }
    'stack-snapshot' { Invoke-StackSnapshot -Purpose 'manual' | ConvertTo-Json -Depth 40 }
    'stack-preflight' { Invoke-WatchdogPreflight -Purpose 'manual' | ConvertTo-Json -Depth 30 }
    'browser-status' { Get-BrowserStackHealthReport | ConvertTo-Json -Depth 20 }
    'browser-health' { Get-BrowserStackHealthReport | ConvertTo-Json -Depth 20 }
    'browser-ensure-visible' { Invoke-BrowserEnsureVisible -Purpose 'manual' | ConvertTo-Json -Depth 30 }
    'browser-relaunch-visible' { Invoke-BrowserRelaunchVisible -Purpose 'manual' | ConvertTo-Json -Depth 30 }
    'chatgpt-page-status' { Get-ChatgptPageStatus -Purpose 'status' | ConvertTo-Json -Depth 12 }
    'chatgpt-ensure-page' { Get-ChatgptPageStatus -Purpose 'ensure' | ConvertTo-Json -Depth 12 }
    'chatgpt-session-status' { Get-ChatgptSessionStatus -Purpose 'status' | ConvertTo-Json -Depth 14 }
    'chatgpt-inventory' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-inventory' -Arguments $EngineArgs }
    'chatgpt-preflight' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-preflight' -Arguments $EngineArgs }
    'chatgpt-auth-status' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-auth-status' -Arguments $EngineArgs }
    'chatgpt-session-warmth' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-session-warmth' -Arguments $EngineArgs }
    'chatgpt-session-warmth-repair' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-session-warmth-repair' -Arguments $EngineArgs }
    'chatgpt-prune-root-targets' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-prune-root-targets' -Arguments $EngineArgs }
    'chatgpt-open-new-chat' { Invoke-ChatgptOpenNewChat -Arguments $EngineArgs }
    'chatgpt-submit-ready-chat' { Invoke-ChatgptSubmitReadyChat -Arguments $EngineArgs }
    'chatgpt-draft' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-draft' -Arguments $EngineArgs }
    'chatgpt-submit' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-submit' -Arguments $EngineArgs }
    'chatgpt-send' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-send' -Arguments $EngineArgs }
    'chatgpt-send-smoke' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-send-smoke' -Arguments $EngineArgs }
    'doctor' { Show-Doctor }
    'doctor-json' { Show-DoctorJson }
    'check-prereq' { Check-Prereq }
    'check-config' { Check-Config }
    'check-autostart' { Get-AutostartSummary | ConvertTo-Json -Depth 12 }
    'check-autologon' { Get-AutologonReport | ConvertTo-Json -Depth 8 }
    'check-console-session' { Get-ConsoleSessionReport | ConvertTo-Json -Depth 10 }
    'desktop-relogin' { Invoke-DesktopRelogin }
    'desktop-preflight' { Get-DesktopPreflightReport | ConvertTo-Json -Depth 16 }
    'desktop-heal-plan' { Get-DesktopHealPlan }
    'desktop-agent-heartbeat' { Write-DesktopAgentHeartbeat }
    'desktop-agent-heartbeat-loop' { Invoke-DesktopAgentHeartbeatLoop }
    'desktop-agent-start-loop' { Start-DesktopAgentLoop }
    'desktop-agent-stop-loop' { Stop-DesktopAgentLoop }
    'desktop-agent-loop-status' { Get-DesktopAgentLoopProcessState | ConvertTo-Json -Depth 12 }
    'desktop-agent-install-task-plan' { Get-DesktopAgentInstallTaskPlan }
    'pre-signout' { Invoke-PreSignoutValidation }
    'post-login' { Invoke-PostLoginValidation }
    'check-cloudflared' {
        try {
            Check-Cloudflared -FailOnMissing
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'aws-secret-status' { Show-AwsSecretStatus }
    # start-chatgpt-oauth / stop-chatgpt-oauth / start-codex-bearer / stop-codex-bearer /
    # runtime-replace-plan / runtime-replace-stale, and every restart-chatgpt-oauth* /
    # restart-codex-bearer* / restart-all* / restart-tunnel branch that used to live here, are
    # gone. Most of the restart-* branches were already dead code - not present in ValidateSet
    # above, so unreachable from the CLI - which is itself the kind of misleading state this
    # cleanup removes: code that reads as a working command but silently could never run. The
    # live ones (start/stop-chatgpt-oauth, start/stop-codex-bearer) ran Start-ManagedProcess /
    # Stop-ManagedProcess directly in the caller's own session - unsafe over SSH. Use
    # start-server / stop-server for everything server-lifecycle related now; internal recovery
    # (Invoke-ManagedRestart) still runs, but only from inside the session-bound watchdog loop.
    'start-tunnel' {
        try {
            Start-Tunnel
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'stop-tunnel' { Stop-Tunnel }
    'watchdog-heal' { Invoke-WatchdogHeal }
    'watchdog-status' { Get-WatchdogStateStatus | ConvertTo-Json -Depth 24 }
    'watchdog-freshness-status' { Get-WatchdogFreshnessStatus | ConvertTo-Json -Depth 20 }
    'system-ready-status' { Get-SystemReadyState | ConvertTo-Json -Depth 24 }
    'watchdog-verify-and-heal' { Invoke-WatchdogVerifyAndHeal | ConvertTo-Json -Depth 30 }
    'test-alert' {
        $sent = Send-WatchdogAlert -Status 'TEST' -Reason 'manual test-alert invocation'
        [pscustomobject]@{ ok = $sent; sent = $sent; configured = -not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_ALERT_WEBHOOK_URL) -or (-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_TELEGRAM_BOT_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_TELEGRAM_CHAT_ID)); next_action = if (-not $sent) { 'set CONSOLE_MCP_ALERT_WEBHOOK_URL or CONSOLE_MCP_TELEGRAM_BOT_TOKEN+CONSOLE_MCP_TELEGRAM_CHAT_ID' } else { 'none' } } | ConvertTo-Json -Depth 4
    }
    'start-watchdog-loop' { Start-WatchdogLoop }
    'restart-watchdog-loop' { Restart-WatchdogLoop }
    'watchdog-loop-status' { Get-WatchdogLoopProcessState | ConvertTo-Json -Depth 20 }
    'watchdog-loop-run' { Invoke-WatchdogLoopRun }
    'install-watchdog-task' { Install-WatchdogTask }
    'show-watchdog-task' { Show-WatchdogTask }
    'install-startup-task' { Install-StartupTask }
    'uninstall-startup-task' { Uninstall-StartupTask }
    'server-lifecycle-prompt' { Invoke-ServerLifecyclePromptCommand }
    'chatgpt-send-lifecycle-review-prompt' { Invoke-ChatgptSendLifecycleReviewPrompt -Arguments $EngineArgs }
    'chatgpt-rename-lifecycle-review-chat' { Invoke-ChatgptRenameLifecycleReviewChat -Arguments $EngineArgs }
    'chatgpt-trace-rename-network' { Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-trace-rename-network' -Arguments $EngineArgs }
    'show-startup-task' { Show-StartupTask }
    'refresh-chatgpt-connector' { Invoke-ChatgptConnectorRefresh }
    'create-shortcuts' { Create-Shortcuts }
    'remove-shortcuts' { Remove-Shortcuts }
    'smoke-local-chatgpt' {
        $result = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt'
        if (-not $result.ok) {
            throw "smoke-local-chatgpt failed."
        }
        $result | ConvertTo-Json -Depth 8
    }
    'smoke-local-codex' {
        $result = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex'
        if (-not $result.ok) {
            throw "smoke-local-codex failed."
        }
        $result | ConvertTo-Json -Depth 10
    }
    'smoke-public' {
        $result = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public'
        if (-not $result.ok) {
            throw "smoke-public failed."
        }
        $result | ConvertTo-Json -Depth 8
    }
    'tail-http-trace' { Tail-File -Path $HttpTraceFile }
    'engine' { Invoke-EngineCli -Arguments $EngineArgs }
    'tail-oauth-debug' { Tail-File -Path $OAuthDebugFile }
    'tail-server-log' { Tail-ServerLog }
    'tail-tunnel-log' { Tail-File -Path $TunnelLogFile }
}
}