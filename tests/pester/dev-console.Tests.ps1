$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entrypointPath = Join-Path $repositoryRoot 'tool/dev-console.ps1'

Describe 'dev-console module loader' {
    It 'keeps the entrypoint available' {
        Test-Path -LiteralPath $entrypointPath -PathType Leaf | Should Be $true
    }

    It 'loads numbered helper modules alphabetically and excludes browser relaunch' {
        $entrypoint = Get-Content -LiteralPath $entrypointPath -Raw

        $entrypoint | Should Match 'Get-ChildItem -LiteralPath \$DevConsoleModuleDir'
        $entrypoint | Should Match 'Sort-Object Name'
        $entrypoint | Should Match "23-browser-relaunch\.ps1"
    }

    It 'keeps watchdog compatibility markers free of business logic' {
        $watchdogMarker = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/40-watchdog.ps1') -Raw
        $orchestrationMarker = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/41-watchdog-orchestration.ps1') -Raw

        $watchdogMarker | Should Not Match '(?im)^\s*function\s+'
        $orchestrationMarker | Should Not Match '(?im)^\s*function\s+'
    }

    It 'uses explicit cadence registration instead of late function replacement' {
        $cadence = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/45-watchdog-cadence.ps1') -Raw
        $housekeeping = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/99-browser-housekeeping.ps1') -Raw

        $cadence | Should Match 'function Register-WatchdogCadenceLane'
        $housekeeping | Should Match 'Register-WatchdogCadenceLane'
        $housekeeping | Should Not Match '\$\{function:Get-WatchdogCadenceDefinition\}'
        $housekeeping | Should Not Match '(?im)^\s*function\s+Get-WatchdogCadenceDefinition\s*\{'
        $housekeeping | Should Not Match '(?im)^\s*function\s+Invoke-WatchdogCadenceLane\s*\{'
    }

    It 'registers runtime environment telemetry as a watchdog cadence lane' {
        $telemetry = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/98-runtime-environment-telemetry.ps1') -Raw
        $runtimeConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/01-runtime-config.ps1') -Raw

        $telemetry | Should Match "Register-WatchdogCadenceLane -Name 'environment' -IntervalSeconds 60"
        $telemetry | Should Match 'CAPTIVE_PORTAL_SUSPECTED'
        $telemetry | Should Match 'DEVTOOLS_PORT_FOREIGN_OWNER'
        $telemetry | Should Match 'HOST_SLEEP_RESUME_OBSERVED'
        $runtimeConfig | Should Match 'RuntimeEnvironmentTelemetryFile'
        $runtimeConfig | Should Match 'ReservedBrowserDevToolsPorts = @\(9222, 9223\)'
        $statusBody = [regex]::Match($telemetry, 'function Get-RuntimeEnvironmentStatus \{(?s)(.*?)\r?\n\}').Groups[1].Value
        $statusBody | Should Match 'Get-RuntimeEnvironmentPreviousState'
        $statusBody | Should Not Match 'Write-RuntimeEnvironmentTelemetry'
        $statusBody | Should Match 'sample_age_seconds'
    }

    It 'keeps runtime environment resource telemetry schema stable and privacy-preserving' {
        $telemetry = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/98-runtime-environment-telemetry.ps1') -Raw

        $telemetry | Should Match 'function Get-RuntimeEnvironmentResourceSnapshot'
        $telemetry | Should Match 'schema_version = 1'
        $telemetry | Should Match 'process_families'
        $telemetry | Should Match 'raw_command_lines_persisted = \$false'
        $telemetry | Should Match 'command_line = \$null'
        $telemetry | Should Match 'command_line_persisted = \$false'
        $telemetry | Should Match 'expected_remote_debugging_port_flag'
        $telemetry | Should Match "aggregated_by_family"
        $telemetry | Should Match 'Get-RuntimeEnvironmentResourceDeltas'
        $telemetry | Should Match 'Get-RuntimeEnvironmentResourcePressure'
        $telemetry | Should Match 'Get-RuntimeEnvironmentEngineExecutionPressure'
        $telemetry | Should Match 'telemetry_errors'
    }

    It 'tracks required process families without host-specific process count assumptions' {
        $telemetry = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/98-runtime-environment-telemetry.ps1') -Raw

        $telemetry | Should Match "@\('php','node','edge','powershell','shell','console_mcp'\)"
        $telemetry | Should Match "New-RuntimeProcessFamilyRecord -Name 'console_mcp'"
        $telemetry | Should Match 'count = \[int\]\$items\.Count'
        $telemetry | Should Match 'private_memory_mb'
        $telemetry | Should Match 'working_set_mb'
        $telemetry | Should Match 'pids_sample_truncated'
        $telemetry | Should Not Match 'process_count -eq'
        $telemetry | Should Not Match 'available_physical_mb -eq'
    }

    It 'keeps Windows telemetry API failures non-fatal and counter support optional' {
        $telemetry = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/98-runtime-environment-telemetry.ps1') -Raw

        $telemetry | Should Match 'New-RuntimeEnvironmentTelemetryError'
        $telemetry | Should Match "Get-Counter -Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit'"
        $telemetry | Should Match "source = 'Win32_OperatingSystem'"
        $telemetry | Should Match "source = 'unavailable'"
        $telemetry | Should Match "New-RuntimeEnvironmentTelemetryError -Source 'Get-Process'"
        $telemetry | Should Match "New-RuntimeEnvironmentTelemetryError -Source 'Win32_Processor'"
        $telemetry | Should Match 'Single-sample classification only'
    }

    It 'registers a non-repairing runtime stability lane with durable transition logging' {
        $stability = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/99-runtime-stability.ps1') -Raw
        $runtimeConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/01-runtime-config.ps1') -Raw

        $stability | Should Match "Register-WatchdogCadenceLane -Name 'runtime_stability' -IntervalSeconds 10"
        $stability | Should Match 'repair_required = \$false'
        $stability | Should Match 'failure_started'
        $stability | Should Match 'failure_recovered'
        $stability | Should Match 'WATCHDOG_OWNERSHIP_MISMATCH'
        $stability | Should Match 'watchdog_ownership_consistent'
        $stability | Should Match 'MCP_PROCESS_EXIT'
        $stability | Should Match 'MCP_CHATGPT_ENDPOINT_UNRESPONSIVE'
        $stability | Should Match 'MCP_CODEX_ENDPOINT_UNRESPONSIVE'
        $stability | Should Match 'MCP_PROTOCOL_UNRESPONSIVE'
        $stability | Should Match 'MCP_PROTOCOL_SMOKE_STALE'
        $stability | Should Match 'LOCAL_AUTH_FUTURE_TIMESTAMP'
        $stability | Should Match 'UtcDateTime'
        $stability | Should Match 'Get-WatchdogCadenceState'

        $cadence = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/45-watchdog-cadence.ps1') -Raw
        $lifecycle = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/44-watchdog-loop-lifecycle.ps1') -Raw
        $cadence | Should Match 'repair_not_before'
        $cadence | Should Match 'CADENCE_REPAIR_DEFERRED'
        $cadence | Should Match 'function Set-WatchdogRepairDeferral'
        $lifecycle | Should Match "Set-WatchdogRepairDeferral -Seconds 30 -Reason 'watchdog_loop_restart_handoff'"
        $lifecycle | Should Match "watchdog-task-bootstrap\.ps1"
        $brokerLoop = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/46-watchdog-broker-loop.ps1') -Raw
        $brokerLoop | Should Match 'console-mcp-watchdog-loop\.owner\.lock'
        $brokerLoop | Should Match 'FileShare\]::None'
        $brokerLoop | Should Match 'DUPLICATE_LOOP_REJECTED'
        $lifecycle | Should Match "Name = 'pwsh\.exe' or Name = 'powershell\.exe'"
        $lifecycle | Should Match 'param\(\[switch\]\$PreferScheduledTask\)'
        $lifecycle | Should Match 'Start-WatchdogLoop -PreferScheduledTask'
        $stability | Should Match 'CDP_UNRESPONSIVE'
        $stability | Should Match 'RESOURCE_TELEMETRY_STALE'
        $stability | Should Match 'Get-RuntimeFailureRecentSummary'
        $stability | Should Match 'failures_5m'
        $stability | Should Match 'failures_15m'
        $stability | Should Match 'failures_60m'
        $stability | Should Match "\$trend = 'SHRINKING'"
        $stability | Should Match 'interval_trend = \$trend'
        $stability | Should Match '\$stability = if'
        $stability | Should Match "'CRITICAL'"
        $stability | Should Match "'RECOVERING'"
        $stability | Should Match 'Get-Content -LiteralPath \$RuntimeFailureLedgerFile -Tail \$MaxEvents'
        $stability | Should Match 'RuntimeEnvironmentStateFile'
        $stability | Should Not Match 'Write-RuntimeEnvironmentTelemetry'
        $runtimeConfig | Should Match 'RuntimeStabilityStateFile'
        $runtimeConfig | Should Match 'RuntimeFailureLedgerFile'
    }

    It 'hardens public tunnel recovery with debounce diagnostics and stable verification' {
        $heal = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/41-watchdog-heal.ps1') -Raw
        $cadence = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/45-watchdog-cadence.ps1') -Raw
        $connector = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/60-connector-refresh.ps1') -Raw

        $heal | Should Match 'function Invoke-PublicTunnelFastRecovery'
        $heal | Should Match 'Start-Sleep -Seconds \$RetryDelaySeconds'
        $heal | Should Match 'Get-PublicTunnelDiagnosticSnapshot'
        $heal | Should Match 'Get-Content -LiteralPath \$TunnelLogFile -Tail \$TailLines'
        $heal | Should Match "action_taken = 'restart_tunnel'"
        $cadence | Should Match 'public_tunnel = 15'
        $cadence | Should Match 'Invoke-PublicTunnelFastRecovery'
        $connector | Should Match '\$StableSuccessCount = 3'
        $connector | Should Match '\$stableCount -ge \$StableSuccessCount'
    }
}
