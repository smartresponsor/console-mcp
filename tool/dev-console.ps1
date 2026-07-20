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

# Shared secret bootstrap is owned by tool/dev-console.d/02-secret-bootstrap.ps1.
$SecretBootstrapModule = Join-Path $PSScriptRoot 'dev-console.d\02-secret-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $SecretBootstrapModule -PathType Leaf)) {
    throw "Required dev-console secret bootstrap module is missing: $SecretBootstrapModule"
}
. $SecretBootstrapModule
Invoke-DevConsoleSecretBootstrap -Command $Command -Root $Root

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
# CLI command dispatch is owned by tool/dev-console.d/99-command-dispatch.ps1.
Invoke-DevConsoleCommand -Command $Command -EngineArgs $EngineArgs














