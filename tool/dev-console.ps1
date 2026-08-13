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
        'aws-status',
        'aws-secrets-qodana-status',
        'aws-secret-qodana-check',
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

# Runtime paths, endpoints, task names, and shared constants are owned by tool/dev-console.d/01-runtime-config.ps1.
$RuntimeConfigModule = Join-Path $PSScriptRoot 'dev-console.d\01-runtime-config.ps1'
if (-not (Test-Path -LiteralPath $RuntimeConfigModule -PathType Leaf)) {
    throw "Required dev-console runtime configuration module is missing: $RuntimeConfigModule"
}
. $RuntimeConfigModule
Initialize-DevConsoleRuntimeConfig -EntryScriptRoot $PSScriptRoot

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
# Runtime workspace and OAuth/Bearer/tunnel process specifications are owned by tool/dev-console.d/53-runtime-control.ps1.

# Expected tool-surface resolution and comparison are owned by tool/dev-console.d/60-connector-refresh.ps1.

# Restart generation and compact server lifecycle telemetry are owned by tool/dev-console.d/90-server-lifecycle.ps1.

# Browser automation output redaction and serialization are owned by tool/dev-console.d/61-chatgpt-session.ps1.

# Restart-state persistence is owned by tool/dev-console.d/90-server-lifecycle.ps1.

# Watchdog state persistence, reading, and freshness reporting are owned by tool/dev-console.d/40-watchdog-state.ps1.

# Runtime and browser postconditions are owned by tool/dev-console.d/53-runtime-control.ps1.

# Server-launch watchdog state refresh is owned by tool/dev-console.d/40-watchdog-launch-state.ps1.
# Watchdog lock acquisition and owner-safe release are owned by tool/dev-console.d/40-watchdog-lock.ps1.
# Watchdog loop heartbeat threshold and broker heartbeat diagnostics are owned by tool/dev-console.d/40-watchdog-heartbeat.ps1.
# Watchdog launch failure classification and unified system-ready reporting are owned by tool/dev-console.d/40-watchdog-readiness.ps1.
# Watchdog scheduled-task declaration self-heal and bounded readiness verification are owned by tool/dev-console.d/40-watchdog-verification.ps1.
# Watchdog heal/snapshot preflight diagnostics are owned by tool/dev-console.d/40-watchdog-preflight.ps1.

# Watchdog artifact retention is owned by tool/dev-console.d/39-watchdog-retention.ps1.
# Watchdog heal orchestration is owned by tool/dev-console.d/41-watchdog-heal.ps1.
# Legacy tool/dev-console.d/41-watchdog-orchestration.ps1 is an empty compatibility marker retained by write policy.
# Watchdog Scheduled Task lifecycle is owned by tool/dev-console.d/42-watchdog-task.ps1.
# Watchdog loop interval, persisted state, and process-state reporting are owned by tool/dev-console.d/43-watchdog-loop-state.ps1.
# Watchdog loop start, stop, and restart lifecycle is owned by tool/dev-console.d/44-watchdog-loop-lifecycle.ps1.
# Watchdog cadence definition, lane state, lane probes, and repair scheduling are owned by tool/dev-console.d/45-watchdog-cadence.ps1.
# Watchdog interactive broker loop execution is owned by tool/dev-console.d/46-watchdog-broker-loop.ps1.
# Supervised restart readiness and managed service restart primitives are owned by tool/dev-console.d/47-supervised-restart.ps1.
# Supervised restart-all and single-service workflows are owned by tool/dev-console.d/48-supervised-restart-workflow.ps1.
# Runtime replacement state, planning, invariants, and execution are owned by tool/dev-console.d/49-runtime-replace.ps1.
# Read-only restart-all planning is owned by tool/dev-console.d/50-restart-plan.ps1.
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














