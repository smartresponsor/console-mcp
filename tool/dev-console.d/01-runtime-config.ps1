function Initialize-DevConsoleRuntimeConfig {
    param([Parameter(Mandatory = $true)][string]$EntryScriptRoot)

    $root = Split-Path -Parent $EntryScriptRoot
    $runDir = Join-Path $root 'var/run'
    $logDir = Join-Path $root 'var/log'
    $transcriptDir = Join-Path $root 'var/transcript'
    $unifiedPidFile = Join-Path $runDir 'console-mcp-unified.pid'
    $defaultWorkspaceRoot = Split-Path -Parent (Split-Path -Parent $root)
    $mobileEdgePort = 8080

    $config = [ordered]@{
        Root = $root
        RunDir = $runDir
        LogDir = $logDir
        TranscriptDir = $transcriptDir
        ServerStateDir = Join-Path $root 'var/server'
        BrowserStateDir = Join-Path $root 'var/browser'
        WatchdogSnapshotDir = Join-Path $root 'var/watchdog'
        StackStateDir = Join-Path $root 'var/stack'
        UnifiedPidFile = $unifiedPidFile
        ChatgptPidFile = $unifiedPidFile
        CodexPidFile = $unifiedPidFile
        TunnelPidFile = Join-Path $runDir 'cloudflared-console-mcp.pid'
        ChatgptLogFile = Join-Path $logDir 'console-mcp-chatgpt-oauth.log'
        CodexLogFile = Join-Path $logDir 'console-mcp-codex-bearer.log'
        TunnelLogFile = Join-Path $logDir 'cloudflared-console-mcp.log'
        HttpTraceFile = Join-Path $transcriptDir 'http-trace.ndjson'
        BuildInfoFile = Join-Path $runDir 'console-mcp-build-info.json'
        RestartStateFile = Join-Path $runDir 'console-mcp-restart-state.json'
        RuntimeReplaceStateFile = Join-Path $runDir 'console-mcp-runtime-replace-state.json'
        ExpectedSurfaceFile = Join-Path $runDir 'console-mcp-expected-surface.json'
        ConnectorRefreshStateFile = Join-Path $runDir 'chatgpt-connector-refresh.json'
        ChatgptSchemaAuditFile = Join-Path $transcriptDir 'schema-audit\last-tools-list-chatgpt.json'
        DesktopAgentStateFile = Join-Path $runDir 'desktop-agent.state.json'
        DesktopAgentLoopPidFile = Join-Path $runDir 'desktop-agent-heartbeat-loop.pid'
        DesktopAgentLoopLogFile = Join-Path $logDir 'desktop-agent-heartbeat-loop.log'
        DesktopAgentTaskName = 'console-mcp-desktop-agent-heartbeat'
        DesktopReloginStateFile = Join-Path $runDir 'desktop-relogin-transaction.json'
        ConnectorRefreshLogFile = Join-Path $logDir 'chatgpt-connector-refresh.log'
        RestartLogFile = Join-Path $logDir 'console-mcp-restart.log'
        ServerLifecycleLogFile = Join-Path $logDir 'server-lifecycle.ndjson'
        ServerLifecyclePromptFile = Join-Path $runDir 'server-lifecycle-launch-prompt.txt'
        ServerLifecycleSendStateFile = Join-Path $runDir 'server-lifecycle-review-send.json'
        WatchdogStateFile = Join-Path $runDir 'console-mcp-watchdog-state.json'
        WatchdogLockFile = Join-Path $runDir 'console-mcp-watchdog.lock'
        WatchdogLogFile = Join-Path $logDir 'console-mcp-watchdog.log'
        WatchdogLoopPidFile = Join-Path $runDir 'console-mcp-watchdog-loop.pid'
        WatchdogLoopStateFile = Join-Path $runDir 'console-mcp-watchdog-loop-state.json'
        WatchdogLoopLogFile = Join-Path $logDir 'console-mcp-watchdog-loop.log'
        WatchdogCadenceStateFile = Join-Path $runDir 'watchdog-cadence-state.json'
        OAuthDebugFile = Join-Path $transcriptDir 'oauth-debug.ndjson'
        ChatgptOrigin = 'http://127.0.0.1:3333'
        CodexOrigin = 'http://127.0.0.1:3334'
        PublicOrigin = 'https://console-mcp.smartresponsor.com'
        OAuthIssuer = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/'
        OAuthAudience = 'https://console-mcp.smartresponsor.com'
        OAuthScope = 'console:read'
        OAuthJwksUri = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/.well-known/jwks.json'
        CloudflaredConfig = Join-Path (Join-Path $HOME '.cloudflared') 'console-mcp.yml'
        DefaultWorkspaceRoot = $defaultWorkspaceRoot
        MobileEdgeWorkspacePath = Join-Path $defaultWorkspaceRoot 'Mobiling\mobile-edge'
        MobileEdgePort = $mobileEdgePort
        MobileEdgeHealthUrl = "http://127.0.0.1:$mobileEdgePort/health"
        MobileEdgeLogDir = Join-Path $logDir 'mobile-edge'
        StartupTaskName = 'console-mcp-chatgpt-oauth'
        WatchdogTaskName = 'console-mcp-watchdog'
        StartupTaskPath = '\'
        StartupTaskCommand = 'start-watchdog-loop'
        ShortcutRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Console MCP'
        LogLock = [object]::new()
    }

    foreach ($entry in $config.GetEnumerator()) {
        Set-Variable -Scope Script -Name $entry.Key -Value $entry.Value
    }
}

