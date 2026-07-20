[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
        'status',
        'doctor',
        'doctor-json',
        'check-cloudflared',
        'check-config',
        'check-prereq',
        'aws-secret-status',
        'check-autostart',
        'check-autologon',
        'check-console-session',
        'desktop-relogin',
        'desktop-preflight',
        'desktop-heal-plan',
        'desktop-agent-heartbeat',
        'desktop-agent-heartbeat-loop',
        'desktop-agent-start-loop',
        'desktop-agent-stop-loop',
        'desktop-agent-loop-status',
        'desktop-agent-install-task-plan',
        'pre-signout',
        'post-login',
        # start-chatgpt-oauth / stop-chatgpt-oauth / start-codex-bearer / stop-codex-bearer /
        # runtime-replace-plan / runtime-replace-stale were removed on purpose, not renamed. They
        # called Start-ManagedProcess/Stop-ManagedProcess directly, in whatever session issued the
        # command - if that was SSH, the server silently re-homed into the SSH session instead of
        # the interactive desktop session. There is now exactly one way to start or stop the
        # server, from any session: start-server / stop-server, both relayed through the
        # Task-Scheduler-bound watchdog loop (tool/dev-console.d/85-session-relay.ps1) so the
        # actual process management always happens in the correct session. See
        # tool/dev-console.d/85-session-relay.ps1 for the mechanism.
        'start-server',
        'stop-server',
        'restart-server',
        'stack-snapshot',
        'stack-preflight',
        'browser-status',
        'browser-health',
        'browser-ensure-visible',
        'browser-relaunch-visible',
        'chatgpt-page-status',
        'chatgpt-ensure-page',
        'chatgpt-session-status',
        'chatgpt-inventory',
        'chatgpt-preflight',
        'chatgpt-auth-status',
        'chatgpt-session-warmth',
        'chatgpt-session-warmth-repair',
        'chatgpt-prune-root-targets',
        'chatgpt-open-new-chat',
        'chatgpt-submit-ready-chat',
        'chatgpt-draft',
        'chatgpt-submit',
        'chatgpt-send',
        'chatgpt-send-smoke',
        'start-tunnel',
        'stop-tunnel',
        'watchdog-heal',
        'watchdog-status',
        'watchdog-freshness-status',
        'system-ready-status',
        'watchdog-verify-and-heal',
        'test-alert',
        'start-watchdog-loop',
        'restart-watchdog-loop',
        'watchdog-loop-status',
        'watchdog-loop-run',
        'install-watchdog-task',
        'show-watchdog-task',
        'install-startup-task',
        'uninstall-startup-task',
        'server-lifecycle-prompt',
        'chatgpt-send-lifecycle-review-prompt',
        'chatgpt-rename-lifecycle-review-chat',
        'chatgpt-trace-rename-network',
        'show-startup-task',
        'refresh-chatgpt-connector',
        'create-shortcuts',
        'remove-shortcuts',
        'smoke-local-chatgpt',
        'smoke-local-codex',
        'smoke-public',
        'engine',
        'tail-http-trace',
        'tail-oauth-debug',
        'tail-server-log',
        'tail-tunnel-log'
    )]
    [string]$Command = 'status',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$EngineArgs = @()
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root 'var/run'
$LogDir = Join-Path $Root 'var/log'
$TranscriptDir = Join-Path $Root 'var/transcript'
$ServerStateDir = Join-Path $Root 'var/server'
$BrowserStateDir = Join-Path $Root 'var/browser'
$WatchdogSnapshotDir = Join-Path $Root 'var/watchdog'
$StackStateDir = Join-Path $Root 'var/stack'
$UnifiedPidFile = Join-Path $RunDir 'console-mcp-unified.pid'
$ChatgptPidFile = $UnifiedPidFile
$CodexPidFile = $UnifiedPidFile
$TunnelPidFile = Join-Path $RunDir 'cloudflared-console-mcp.pid'
$ChatgptLogFile = Join-Path $LogDir 'console-mcp-chatgpt-oauth.log'
$CodexLogFile = Join-Path $LogDir 'console-mcp-codex-bearer.log'
$TunnelLogFile = Join-Path $LogDir 'cloudflared-console-mcp.log'
$HttpTraceFile = Join-Path $TranscriptDir 'http-trace.ndjson'
$BuildInfoFile = Join-Path $RunDir 'console-mcp-build-info.json'
$RestartStateFile = Join-Path $RunDir 'console-mcp-restart-state.json'
$RuntimeReplaceStateFile = Join-Path $RunDir 'console-mcp-runtime-replace-state.json'
$ExpectedSurfaceFile = Join-Path $RunDir 'console-mcp-expected-surface.json'
$ConnectorRefreshStateFile = Join-Path $RunDir 'chatgpt-connector-refresh.json'
$ChatgptSchemaAuditFile = Join-Path $TranscriptDir 'schema-audit\last-tools-list-chatgpt.json'
$DesktopAgentStateFile = Join-Path $RunDir 'desktop-agent.state.json'
$DesktopAgentLoopPidFile = Join-Path $RunDir 'desktop-agent-heartbeat-loop.pid'
$DesktopAgentLoopLogFile = Join-Path $LogDir 'desktop-agent-heartbeat-loop.log'
$DesktopAgentTaskName = 'console-mcp-desktop-agent-heartbeat'
$DesktopReloginStateFile = Join-Path $RunDir 'desktop-relogin-transaction.json'
$ConnectorRefreshLogFile = Join-Path $LogDir 'chatgpt-connector-refresh.log'
$RestartLogFile = Join-Path $LogDir 'console-mcp-restart.log'
$ServerLifecycleLogFile = Join-Path $LogDir 'server-lifecycle.ndjson'
$ServerLifecyclePromptFile = Join-Path $RunDir 'server-lifecycle-launch-prompt.txt'
$ServerLifecycleSendStateFile = Join-Path $RunDir 'server-lifecycle-review-send.json'
$WatchdogStateFile = Join-Path $RunDir 'console-mcp-watchdog-state.json'
$WatchdogLockFile = Join-Path $RunDir 'console-mcp-watchdog.lock'
$WatchdogLogFile = Join-Path $LogDir 'console-mcp-watchdog.log'
$WatchdogLoopPidFile = Join-Path $RunDir 'console-mcp-watchdog-loop.pid'
$WatchdogLoopStateFile = Join-Path $RunDir 'console-mcp-watchdog-loop-state.json'
$WatchdogLoopLogFile = Join-Path $LogDir 'console-mcp-watchdog-loop.log'
$WatchdogCadenceStateFile = Join-Path $RunDir 'watchdog-cadence-state.json'
$OAuthDebugFile = Join-Path $TranscriptDir 'oauth-debug.ndjson'
$ChatgptOrigin = 'http://127.0.0.1:3333'
$CodexOrigin = 'http://127.0.0.1:3334'
$PublicOrigin = 'https://console-mcp.smartresponsor.com'
$OAuthIssuer = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/'
$OAuthAudience = 'https://console-mcp.smartresponsor.com'
$OAuthScope = 'console:read'
$OAuthJwksUri = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/.well-known/jwks.json'
$CloudflaredConfig = Join-Path (Join-Path $HOME '.cloudflared') 'console-mcp.yml'
$DefaultWorkspaceRoot = Split-Path -Parent (Split-Path -Parent $Root)
$MobileEdgeWorkspacePath = Join-Path $DefaultWorkspaceRoot 'Mobiling\mobile-edge'
$MobileEdgePort = 8080
$MobileEdgeHealthUrl = "http://127.0.0.1:$MobileEdgePort/health"
$MobileEdgeLogDir = Join-Path $LogDir 'mobile-edge'
$StartupTaskName = 'console-mcp-chatgpt-oauth'
$WatchdogTaskName = 'console-mcp-watchdog'
$StartupTaskPath = '\'
$StartupTaskCommand = 'start-watchdog-loop'
$ShortcutRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Console MCP'
$LogLock = [object]::new()

$RequestedCommand = $Command
$DevConsoleRoot = $Root
$McpWorkspaceRoot = Split-Path -Parent $Root
$SharedSecretRuntime = Join-Path $McpWorkspaceRoot 'AwsSecretContract\tool\secret-runtime.ps1'
$SecretBootstrapCommands = @(
    'status',
    'doctor',
    'doctor-json',
    'start-server',
    'stop-server',
    'watchdog-heal',
    'smoke-local-codex'
)
if ($SecretBootstrapCommands -contains $Command -and (Test-Path -LiteralPath $SharedSecretRuntime -PathType Leaf)) {
    & {
        . $SharedSecretRuntime -Command export-env -Consumer console-mcp -IncludePrevious
    }
}
$Root = $DevConsoleRoot
$Command = $RequestedCommand
$ErrorActionPreference = 'Stop'

# Runtime directory initialization is owned by tool/dev-console.d/00-bootstrap.ps1.
$BootstrapModule = Join-Path $PSScriptRoot 'dev-console.d\00-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $BootstrapModule -PathType Leaf)) {
    throw "Required dev-console bootstrap module is missing: $BootstrapModule"
}
. $BootstrapModule
Ensure-Directories

# Build output generation and fingerprint reporting are owned by tool/dev-console.d/50-build-output.ps1.

# Runtime and watchdog freshness reporting are owned by tool/dev-console.d/53-runtime-control.ps1.
# Runtime workspace and OAuth/Bearer process specifications are owned by tool/dev-console.d/53-runtime-control.ps1.

# Expected tool-surface resolution and comparison are owned by tool/dev-console.d/60-connector-refresh.ps1.

# Restart generation and compact server lifecycle telemetry are owned by tool/dev-console.d/90-server-lifecycle.ps1.

# Browser automation output redaction and serialization are owned by tool/dev-console.d/61-chatgpt-session.ps1.

# Restart-state persistence is owned by tool/dev-console.d/90-server-lifecycle.ps1.

# Watchdog state reading and freshness reporting are owned by tool/dev-console.d/40-watchdog.ps1.

# Runtime and browser postconditions are owned by tool/dev-console.d/53-runtime-control.ps1.

# Watchdog state persistence, server-launch state refresh, and lock ownership are owned by tool/dev-console.d/40-watchdog.ps1.

$RetentionMarkerFile = Join-Path $RunDir 'console-mcp-retention-last-run.json'
$RetentionTargets = @(
    [pscustomobject]@{ Path = (Join-Path $Root 'var/transcript'); MaxAgeDays = 7 },
    [pscustomobject]@{ Path = (Join-Path $Root 'var/browser'); MaxAgeDays = 7 },
    [pscustomobject]@{ Path = (Join-Path $Root 'var/stack'); MaxAgeDays = 14 }
)

# var/transcript grew to 7880+ small per-call JSON files over 9 days (CONSOLE_MCP_TRACE=1 on both
# profiles writes one file per MCP call, including the watchdog's own smoke checks every ~15-20s)
# with nothing ever pruning it - unbounded directory growth, no retention. console.write.
# framework.symfony.var.prune is for OTHER (target) workspaces, not console-mcp's own var/.
# Run at most once per $IntervalHours (gated by a marker file) so this stays cheap on most ticks.
# Watchdog cadence, health, and restart orchestration are owned by tool/dev-console.d/41-watchdog-orchestration.ps1.
# Prerequisite, configuration, cloudflared, and doctor diagnostics are owned by tool/dev-console.d/51-diagnostics.ps1.

# Windows scheduled-task and Start-menu shortcut entrypoints are owned by tool/dev-console.d/52-windows-entrypoints.ps1.

# Unified server and tunnel lifecycle control is owned by tool/dev-console.d/53-runtime-control.ps1.

# Connector refresh state, validation, and execution are owned by tool/dev-console.d/60-connector-refresh.ps1.

# Local and public MCP smoke probes are owned by tool/dev-console.d/54-smoke-probes.ps1.

# Process, port, text sanitization, and log support are owned by tool/dev-console.d/55-process-support.ps1.

# External command resolution and server-log entrypoints are owned by tool/dev-console.d/56-command-resolution.ps1.

# Bearer secret resolution and reporting are owned by tool/dev-console.d/53-runtime-control.ps1.
# Watchdog alert transport and notification de-duplication are owned by tool/dev-console.d/55-process-support.ps1.

# Engine CLI command execution is owned by tool/dev-console.d/56-command-resolution.ps1.

# ChatGPT session CLI and lifecycle prompt orchestration are owned by tool/dev-console.d/61-chatgpt-session.ps1.
$DevConsoleModuleDir = Join-Path $PSScriptRoot 'dev-console.d'
if (Test-Path -LiteralPath $DevConsoleModuleDir -PathType Container) {
    Get-ChildItem -LiteralPath $DevConsoleModuleDir -Filter '*.ps1' -File | Sort-Object Name | ForEach-Object { . $_.FullName }
}

# Interactive desktop capability lease and visible browser relaunch are owned by tool/dev-console.d/23-browser-relaunch.ps1.
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














