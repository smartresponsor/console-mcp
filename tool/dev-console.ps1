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

function Ensure-Directories {
    foreach ($path in @($RunDir, $LogDir, $TranscriptDir, $ServerStateDir, $BrowserStateDir, $WatchdogSnapshotDir, $StackStateDir)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

Ensure-Directories

function Ensure-BuildOutput {
    # NOTE: this used to gate on a one-shot $script:BuildOutputEnsured flag that, once true, made
    # this function a permanent no-op for the rest of the CURRENT PowerShell PROCESS's lifetime.
    # That's fine for a short-lived CLI invocation (build once, exit) but was a severe bug for the
    # long-running watchdog-loop process: once the flag flipped true early in that process's life
    # (which can run for days), every later 'warm restart' issued by the watchdog silently skipped
    # `npm run build` even when source had genuinely changed - so a detected 'stale' dist never
    # actually got rebuilt by the watchdog's own recovery path, staleness never cleared, and the
    # watchdog kept restarting the service every ~15-20s forever. Gate on the real, stateless
    # freshness check every time instead; it's cheap enough (file hash comparison) to call per
    # restart, and it correctly no-ops once the build is genuinely current.
    $report = Get-BuildOutputReport
    if ($report.build_current -eq $true) {
        return $report
    }

    # Cross-process guard: two managed processes/CLI invocations can independently decide a
    # rebuild is needed at the same moment (e.g. watchdog-loop healing chatgpt-oauth while someone
    # runs restart-codex-bearer-warm by hand). Without this, two concurrent `npm run build` (tsc)
    # runs could race writing the same dist/*.js files - producing a corrupted/partial dist, which
    # is a worse failure than merely-stale dist.
    $buildMutex = New-Object System.Threading.Mutex($false, 'Global\console-mcp-build-lock')
    $mutexAcquired = $false
    try {
        $mutexAcquired = $buildMutex.WaitOne([TimeSpan]::FromSeconds(120))
        if (-not $mutexAcquired) {
            throw "Timed out waiting for another console-mcp build to finish (build lock held longer than 120s)."
        }

        # Re-check after acquiring the lock: another process may have already rebuilt while we waited.
        $report = Get-BuildOutputReport
        if ($report.build_current -eq $true) {
            return $report
        }

        Ensure-Directories
        $npm = Get-NpmCommand
        Push-Location $Root
        try {
            $buildOutput = & $npm run build 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        if ($exitCode -ne 0) {
            $message = Sanitize-Text (($buildOutput | Out-String).Trim())
            throw "npm run build failed before console-mcp server start. $message"
        }

        $distIndex = Join-Path $Root 'dist/index.js'
        if (-not (Test-Path -LiteralPath $distIndex)) {
            throw "npm run build completed but dist/index.js was not produced."
        }

        $report = Get-BuildOutputReport -Force
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $BuildInfoFile -Encoding utf8
        return $report
    } finally {
        if ($mutexAcquired) {
            $buildMutex.ReleaseMutex()
        }
        $buildMutex.Dispose()
    }
}

function Get-RepoRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath.Substring($rootPath.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
    }
    return $fullPath.Replace('\', '/')
}

function Get-BuildInputFiles {
    $candidates = @()
    foreach ($path in @('src')) {
        $fullPath = Join-Path $Root $path
        if (Test-Path -LiteralPath $fullPath) {
            $candidates += Get-ChildItem -LiteralPath $fullPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.ts', '.json') }
        }
    }
    foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json')) {
        $fullPath = Join-Path $Root $file
        if (Test-Path -LiteralPath $fullPath) {
            $candidates += Get-Item -LiteralPath $fullPath
        }
    }
    return @($candidates | Sort-Object FullName -Unique)
}

function Get-DistFingerprintFiles {
    $distPath = Join-Path $Root 'dist'
    if (-not (Test-Path -LiteralPath $distPath)) { return @() }
    return @(Get-ChildItem -LiteralPath $distPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.js', '.json', '.map') } | Sort-Object FullName -Unique)
}

function New-FileSetFingerprint {
    param([object[]]$Files)
    $items = @($Files | Where-Object { $_ -and (Test-Path -LiteralPath $_.FullName -PathType Leaf) } | Sort-Object FullName -Unique)
    $lines = @()
    $totalBytes = [int64]0
    $newest = $null
    foreach ($item in $items) {
        $hash = Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256
        $relativePath = Get-RepoRelativePath -Path $item.FullName
        $lines += "$relativePath|$($item.Length)|$($hash.Hash.ToLowerInvariant())"
        $totalBytes += [int64]$item.Length
        if ($null -eq $newest -or $item.LastWriteTimeUtc -gt $newest.LastWriteTimeUtc) { $newest = $item }
    }
    $payload = [string]::Join("`n", $lines)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $digest = $sha.ComputeHash($bytes)
        $fingerprint = ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{
        algorithm = 'sha256'
        sha256 = $fingerprint
        file_count = $items.Count
        total_bytes = $totalBytes
        newest_file = if ($newest) {
            [pscustomobject]@{
                path = Get-RepoRelativePath -Path $newest.FullName
                last_write_time = $newest.LastWriteTime
            }
        } else { $null }
    }
}

function Get-BuildInfoSnapshot {
    if (-not (Test-Path -LiteralPath $BuildInfoFile -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $BuildInfoFile -Raw | ConvertFrom-Json -Depth 20)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'BUILD_INFO_UNREADABLE'
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Test-BuildCurrent {
    param(
        [object]$DistItem,
        [object]$NewestSource,
        [object]$SourceFingerprint,
        [object]$DistFingerprint,
        [object]$BuildInfo
    )
    if (-not $DistItem) {
        return [pscustomobject]@{ current = $false; reason = 'missing_dist'; build_needed = $true }
    }

    $recordedSourceHash = $null
    $recordedDistHash = $null
    $recordedFingerprintVersion = $null
    if ($BuildInfo) {
        try { $recordedSourceHash = [string]$BuildInfo.source_fingerprint.sha256 } catch { $recordedSourceHash = $null }
        try { $recordedDistHash = [string]$BuildInfo.dist_fingerprint.sha256 } catch { $recordedDistHash = $null }
        try { $recordedFingerprintVersion = [int]$BuildInfo.fingerprint_version } catch { $recordedFingerprintVersion = $null }
    }

    if ($recordedFingerprintVersion -eq 1 -and -not [string]::IsNullOrWhiteSpace($recordedSourceHash)) {
        if ($recordedSourceHash -ne [string]$SourceFingerprint.sha256) {
            if ($NewestSource -and $DistItem -and $NewestSource.LastWriteTimeUtc -le $DistItem.LastWriteTimeUtc) {
                return [pscustomobject]@{ current = $true; reason = 'current'; build_needed = $false }
            }
            return [pscustomobject]@{ current = $false; reason = 'fingerprint_mismatch'; build_needed = $true }
        }
        if (-not [string]::IsNullOrWhiteSpace($recordedDistHash) -and $recordedDistHash -ne [string]$DistFingerprint.sha256) {
            return [pscustomobject]@{ current = $false; reason = 'fingerprint_mismatch'; build_needed = $true }
        }
        return [pscustomobject]@{ current = $true; reason = 'current'; build_needed = $false }
    }

    if ($NewestSource -and $NewestSource.LastWriteTimeUtc -gt $DistItem.LastWriteTimeUtc) {
        return [pscustomobject]@{ current = $false; reason = 'timestamp_newer'; build_needed = $true }
    }
    if ($BuildInfo -and $recordedFingerprintVersion -ne 1) {
        return [pscustomobject]@{ current = $false; reason = 'unsupported_fingerprint_version'; build_needed = $true }
    }
    return [pscustomobject]@{ current = $false; reason = 'unknown'; build_needed = $true }
}

function Test-BuildInfoNeedsUpdate {
    param(
        [object]$BuildInfo,
        [object]$Report
    )
    if (-not $BuildInfo) { return $true }
    try {
        if ([int]$BuildInfo.fingerprint_version -ne [int]$Report.fingerprint_version) { return $true }
    } catch { return $true }
    try {
        if ([string]$BuildInfo.source_fingerprint.sha256 -ne [string]$Report.source_fingerprint.sha256) { return $true }
        if ([string]$BuildInfo.dist_fingerprint.sha256 -ne [string]$Report.dist_fingerprint.sha256) { return $true }
    } catch { return $true }
    return $false
}

$script:BuildOutputReportCache = $null
$script:BuildOutputReportCacheAt = [datetime]::MinValue

function Get-BuildOutputReport {
    param([int]$CacheTtlSeconds = 3, [switch]$Force)

    # Short, time-bounded cache (NOT the old sticky-forever $script:BuildOutputEnsured pattern -
    # this always re-checks after $CacheTtlSeconds). This function hashes ~150 files under src/
    # and dist/ on every call; Ensure-BuildOutput and Get-ChatgptRuntimeFreshness both call it
    # multiple times within a single watchdog heal cycle, so without this a single tick was paying
    # for the same full rehash 3-4 times in a row. A few seconds of staleness here is harmless -
    # ticks run every 15-20s anyway, so genuine source changes are still picked up promptly.
    # -Force bypasses the cache entirely: used right after a real `npm run build` completes, since
    # a fast/incremental build can finish inside the cache TTL window and must not be reported
    # against pre-build data.
    if (-not $Force -and $script:BuildOutputReportCache -and ((Get-Date) - $script:BuildOutputReportCacheAt).TotalSeconds -lt $CacheTtlSeconds) {
        return $script:BuildOutputReportCache
    }

    $distIndex = Join-Path $Root 'dist/index.js'
    $distItem = Get-Item -LiteralPath $distIndex -ErrorAction SilentlyContinue
    $newestSource = Get-NewestBuildInput
    $sourceFingerprint = New-FileSetFingerprint -Files (Get-BuildInputFiles)
    $distFingerprint = New-FileSetFingerprint -Files (Get-DistFingerprintFiles)
    $buildInfo = Get-BuildInfoSnapshot
    $freshness = Test-BuildCurrent -DistItem $distItem -NewestSource $newestSource -SourceFingerprint $sourceFingerprint -DistFingerprint $distFingerprint -BuildInfo $buildInfo

    $report = [pscustomobject]@{
        dist_index = [pscustomobject]@{
            path = $distIndex
            exists = [bool]$distItem
            length = if ($distItem) { $distItem.Length } else { $null }
            last_write_time = if ($distItem) { $distItem.LastWriteTime } else { $null }
        }
        newest_build_input = if ($newestSource) {
            [pscustomobject]@{
                path = $newestSource.FullName
                last_write_time = $newestSource.LastWriteTime
            }
        } else { $null }
        build_needed = [bool]$freshness.build_needed
        build_current = [bool]$freshness.current
        build_reason = [string]$freshness.reason
        fingerprint_version = 1
        source_fingerprint = $sourceFingerprint
        dist_fingerprint = $distFingerprint
        build_info_file = $BuildInfoFile
        build_info_written = Test-Path -LiteralPath $BuildInfoFile
    }
    if ($report.build_current -eq $true -and (Test-BuildInfoNeedsUpdate -BuildInfo $buildInfo -Report $report)) {
        $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $BuildInfoFile -Encoding utf8
        $report.build_info_written = $true
    }
    $script:BuildOutputReportCache = $report
    $script:BuildOutputReportCacheAt = Get-Date
    return $report
}

function Get-ChatgptRuntimeFreshness {
    $spec = Get-ChatgptSpec
    $state = Get-ManagedProcessState -Spec $spec
    $build = Get-BuildOutputReport
    $process = $null
    $processStartedAt = $null
    $distStartedAfterBuild = $false

    if ($state.pid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
        if ($process -and $process.CreationDate) {
            $processStartedAt = $process.CreationDate
        }
    }

    $distLastWrite = $null
    if ($build.dist_index -and $build.dist_index.exists -and $build.dist_index.last_write_time) {
        $distLastWrite = [datetime]$build.dist_index.last_write_time
    }

    if ($processStartedAt -and $distLastWrite) {
        $distStartedAfterBuild = $processStartedAt.ToUniversalTime() -ge $distLastWrite.ToUniversalTime().AddSeconds(-2)
    }

    $fresh = [bool]($state.running -and $state.port_open -and -not $build.build_needed -and $distStartedAfterBuild)
    $reasons = @()
    if (-not $state.running) { $reasons += 'service_not_running' }
    if (-not $state.port_open) { $reasons += 'port_not_open' }
    if ($build.build_needed) { $reasons += 'build_output_stale' }
    if ($state.running -and $distLastWrite -and -not $distStartedAfterBuild) { $reasons += 'process_started_before_dist_build' }

    return [pscustomobject]@{
        ok = $fresh
        status = if ($fresh) { 'FRESH' } else { 'STALE' }
        reasons = $reasons
        service = $state
        build_output = $build
        process_started_at = if ($processStartedAt) { $processStartedAt.ToString('o') } else { $null }
        dist_last_write_time = if ($distLastWrite) { $distLastWrite.ToString('o') } else { $null }
    }
}

function Get-WatchdogFreshnessStatus {
    return [pscustomobject]@{
        ok = $true
        status = 'WATCHDOG_FRESHNESS_STATUS'
        chatgpt_oauth = Get-ChatgptRuntimeFreshness
        restart = Get-RestartState
        watchdog = Get-WatchdogState
    }
}

function Get-NewestBuildInput {
    return (Get-BuildInputFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
}

function Get-WorkspaceRoot {
    $configured = $env:CONSOLE_MCP_WORKSPACE_ROOT
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return $configured.Trim()
    }

    return $DefaultWorkspaceRoot
}

function Get-ChatgptSpec {
    return [pscustomobject]@{
        Name = 'chatgpt-oauth'
        Mode = 'oauth'
        Port = 3333
        Origin = $ChatgptOrigin
        PidFile = $ChatgptPidFile
        LogFile = $ChatgptLogFile
        Matcher = '(?i)(node|npm(\.cmd)?)\b.*(dist[\\/]+index\.js|npm\s+run\s+start)'
        UseMatcherFallback = $false
        RequiresBearerToken = $false
        Environment = [ordered]@{
            CONSOLE_MCP_AUTH_MODE = 'oauth'
            CONSOLE_MCP_PUBLIC_ORIGIN = $PublicOrigin
            CONSOLE_MCP_OAUTH_ISSUER = $OAuthIssuer
            CONSOLE_MCP_OAUTH_AUDIENCE = $OAuthAudience
            CONSOLE_MCP_OAUTH_REQUIRED_SCOPE = $OAuthScope
            CONSOLE_MCP_OAUTH_JWKS_URI = $OAuthJwksUri
            CONSOLE_MCP_OAUTH_DEBUG = '1'
            CONSOLE_MCP_TRACE = '1'
            CONSOLE_MCP_HOST = '127.0.0.1'
            CONSOLE_MCP_PORT = '3333'
            CONSOLE_MCP_WORKSPACE_ROOT = $DefaultWorkspaceRoot
            CONSOLE_MCP_MANAGED_RUNTIME = 'watchdog-session-relay'
        }
    }
}

function Get-CodexSpec {
    return [pscustomobject]@{
        Name = 'codex-bearer'
        Mode = 'bearer'
        Port = 3334
        Origin = $CodexOrigin
        PidFile = $CodexPidFile
        LogFile = $CodexLogFile
        Matcher = '(?i)(node|npm(\.cmd)?)\b.*(dist[\\/]+index\.js|npm\s+run\s+start)'
        UseMatcherFallback = $false
        RequiresBearerToken = $true
        Environment = [ordered]@{
            CONSOLE_MCP_AUTH_MODE = 'bearer'
            CONSOLE_MCP_TRACE = '1'
            CONSOLE_MCP_HOST = '127.0.0.1'
            CONSOLE_MCP_PORT = '3334'
            CONSOLE_MCP_WORKSPACE_ROOT = $DefaultWorkspaceRoot
            CONSOLE_MCP_MANAGED_RUNTIME = 'watchdog-session-relay'
        }
    }
}

function Get-DefaultExpectedSurface {
    $configured = $env:CONSOLE_MCP_EXPECTED_TOOLS
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return @($configured.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    }

    return Get-PolicyExpectedToolSurface
}

function Get-PolicyExpectedToolSurface {
    $indexPath = Join-Path $Root 'policy/console-tool-catalog-index.json'
    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
    $names = @()
    foreach ($fragmentPath in @($index.fragments)) {
        $fragmentFullPath = Join-Path $Root ([string]$fragmentPath)
        $fragment = Get-Content -LiteralPath $fragmentFullPath -Raw | ConvertFrom-Json
        foreach ($tool in @($fragment.tools)) {
            if ($tool.canonicalName) {
                $names += [string]$tool.canonicalName
            }
            foreach ($extraName in @($tool.canonicalReadAliases)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$extraName)) {
                    $names += [string]$extraName
                }
            }
        }
    }

    return @($names | Sort-Object -Unique)
}

function Compare-ToolSurface {
    param(
        [string[]]$ExpectedTools = @(),
        [string[]]$RuntimeTools = @()
    )

    $expected = @($ExpectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $runtime = @($RuntimeTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $missing = @($expected | Where-Object { $runtime -notcontains $_ })
    $unexpected = @($runtime | Where-Object { $expected -notcontains $_ })

    return [pscustomobject]@{
        ok = $missing.Count -eq 0 -and $unexpected.Count -eq 0
        status = if ($missing.Count -eq 0 -and $unexpected.Count -eq 0) { 'RUNTIME_TOOLS_MATCH_EXPECTED' } else { 'RUNTIME_TOOLS_DIFFER_FROM_EXPECTED' }
        expected_count = $expected.Count
        runtime_count = $runtime.Count
        missing_count = $missing.Count
        unexpected_count = $unexpected.Count
        missing = $missing
        unexpected = $unexpected
    }
}

function New-RestartGeneration {
    return (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
}

function Get-ObjectPropertyValue {
    param([object]$Value, [Parameter(Mandatory = $true)][string]$Name)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary] -and $Value.Contains($Name)) { return $Value[$Name] }
    if ($Value.PSObject.Properties.Name -contains $Name) { return $Value.$Name }
    return $null
}

function ConvertTo-CompactLifecycleNode {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    $status = Get-ObjectPropertyValue -Value $Value -Name 'status'
    $ok = Get-ObjectPropertyValue -Value $Value -Name 'ok'
    $running = Get-ObjectPropertyValue -Value $Value -Name 'running'
    $portOpen = Get-ObjectPropertyValue -Value $Value -Name 'port_open'
    $chatId = Get-ObjectPropertyValue -Value $Value -Name 'chat_id'
    $nextAction = Get-ObjectPropertyValue -Value $Value -Name 'next_action'
    return [pscustomobject]@{
        ok = if ($null -ne $ok) { [bool]$ok } else { $null }
        status = if ($status) { [string]$status } else { $null }
        running = if ($null -ne $running) { [bool]$running } else { $null }
        port_open = if ($null -ne $portOpen) { [bool]$portOpen } else { $null }
        chat_id = if ($chatId) { [string]$chatId } else { $null }
        next_action = if ($nextAction) { [string]$nextAction } else { $null }
    }
}

function Add-CompactLifecycleIssue {
    param([System.Collections.Generic.List[string]]$Issues, [string]$Name, [object]$Value)
    if ($null -eq $Value) { return }
    $ok = Get-ObjectPropertyValue -Value $Value -Name 'ok'
    $status = Get-ObjectPropertyValue -Value $Value -Name 'status'
    if ($null -ne $ok -and [bool]$ok -eq $false) {
        $issueStatus = if ($status) { [string]$status } else { 'not-ok' }
        $Issues.Add(("{0}:{1}" -f $Name, $issueStatus)) | Out-Null
    }
}

function ConvertTo-CompactLifecycleSummary {
    param(
        [string]$Operation = 'unknown',
        [string]$Generation = $null,
        [string]$Mode = $null,
        [string]$Scope = $null,
        [string]$Phase = $null,
        [string]$Status = $null,
        [object]$Ok = $null,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )
    $issues = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $issues.Add(('error:' + (Sanitize-Text $ErrorMessage))) | Out-Null }
    $chatgptOauth = $null; $codexBearer = $null; $tunnel = $null; $public = $null; $browser = $null; $warmth = $null; $connectorRefresh = $null
    if ($Detail) {
        $chatgptOauth = Get-ObjectPropertyValue -Value $Detail -Name 'chatgpt_oauth'
        if (-not $chatgptOauth) { $chatgptOauth = Get-ObjectPropertyValue -Value $Detail -Name 'chatgpt' }
        $codexBearer = Get-ObjectPropertyValue -Value $Detail -Name 'codex_bearer'
        if (-not $codexBearer) { $codexBearer = Get-ObjectPropertyValue -Value $Detail -Name 'codex' }
        $tunnel = Get-ObjectPropertyValue -Value $Detail -Name 'tunnel'
        $public = Get-ObjectPropertyValue -Value $Detail -Name 'public'
        $browser = Get-ObjectPropertyValue -Value $Detail -Name 'browser'
        $connectorRefresh = Get-ObjectPropertyValue -Value $Detail -Name 'connector_refresh'
        if ($browser) { $warmth = Get-ObjectPropertyValue -Value $browser -Name 'chatgpt_session_warmth' }
        if (-not $warmth) { $warmth = Get-ObjectPropertyValue -Value $Detail -Name 'chatgpt_session_warmth' }
    }
    foreach ($pair in @(
        @{ name = 'chatgpt_oauth'; value = $chatgptOauth }, @{ name = 'codex_bearer'; value = $codexBearer },
        @{ name = 'tunnel'; value = $tunnel }, @{ name = 'public'; value = $public },
        @{ name = 'browser'; value = $browser }, @{ name = 'chatgpt_session_warmth'; value = $warmth },
        @{ name = 'connector_refresh'; value = $connectorRefresh }
    )) { Add-CompactLifecycleIssue -Issues $issues -Name $pair.name -Value $pair.value }
    $nextAction = $null
    if ($warmth) { $nextAction = Get-ObjectPropertyValue -Value $warmth -Name 'next_action' }
    if (-not $nextAction -and $browser) { $nextAction = Get-ObjectPropertyValue -Value $browser -Name 'next_action' }
    if (-not $nextAction) { $nextAction = 'none' }
    return [pscustomobject]@{
        ts = (Get-Date).ToString('o'); op = $Operation; generation = $Generation; mode = $Mode; scope = $Scope; phase = $Phase; status = $Status
        ok = if ($null -ne $Ok) { [bool]$Ok } else { $null }
        chatgpt_oauth = ConvertTo-CompactLifecycleNode -Value $chatgptOauth; codex_bearer = ConvertTo-CompactLifecycleNode -Value $codexBearer
        tunnel = ConvertTo-CompactLifecycleNode -Value $tunnel; public = ConvertTo-CompactLifecycleNode -Value $public; browser = ConvertTo-CompactLifecycleNode -Value $browser
        chatgpt_session_warmth = ConvertTo-CompactLifecycleNode -Value $warmth; connector_refresh = ConvertTo-CompactLifecycleNode -Value $connectorRefresh
        issue_count = $issues.Count; issues = @($issues); next_action = [string]$nextAction
    }
}

function Write-ServerLifecycleEvent {
    param(
        [string]$Operation = 'unknown', [string]$Generation = $null, [string]$Mode = $null, [string]$Scope = $null,
        [string]$Phase = $null, [string]$Status = $null, [object]$Ok = $null, [object]$Detail = $null, [string]$ErrorMessage = $null
    )
    Ensure-Directories
    $record = ConvertTo-CompactLifecycleSummary -Operation $Operation -Generation $Generation -Mode $Mode -Scope $Scope -Phase $Phase -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage
    Write-SafeLogLine -Path $ServerLifecycleLogFile -Text ($record | ConvertTo-Json -Depth 8 -Compress)
    return $record
}

function ConvertTo-SafeBrowserAutomationOutput {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if ($Value.Contains('client-bootstrap')) { return '[redacted]' }
        return $Value
    }
    if ($Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string]) -and -not ($Value -is [System.Collections.IDictionary])) {
        $items = @()
        foreach ($item in $Value) { $items += ConvertTo-SafeBrowserAutomationOutput -Value $item }
        Write-Output -NoEnumerate ([object[]]$items)
        return
    }

    $names = if ($Value -is [System.Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties.Name) }
    $hasTargetShape = ($names -contains 'id' -or $names -contains 'targetId') -and ($names -contains 'type' -or $names -contains 'url') -and ($names -contains 'webSocketDebuggerUrl' -or $names -contains 'web_socket_debugger_url' -or $names -contains 'devtoolsFrontendUrl' -or $names -contains 'devtools_frontend_url' -or $names -contains 'chat_id')
    if ($hasTargetShape) {
        return [pscustomobject]@{
            port = Get-ObjectPropertyValue -Value $Value -Name 'port'
            id = if (Get-ObjectPropertyValue -Value $Value -Name 'id') { Get-ObjectPropertyValue -Value $Value -Name 'id' } else { Get-ObjectPropertyValue -Value $Value -Name 'targetId' }
            type = Get-ObjectPropertyValue -Value $Value -Name 'type'
            title = Get-ObjectPropertyValue -Value $Value -Name 'title'
            url = Get-ObjectPropertyValue -Value $Value -Name 'url'
            chat_id = Get-ObjectPropertyValue -Value $Value -Name 'chat_id'
            has_web_socket_debugger_url = [bool]((Get-ObjectPropertyValue -Value $Value -Name 'has_web_socket_debugger_url') -or (Get-ObjectPropertyValue -Value $Value -Name 'webSocketDebuggerUrl') -or (Get-ObjectPropertyValue -Value $Value -Name 'web_socket_debugger_url') -or (Get-ObjectPropertyValue -Value $Value -Name 'devtoolsFrontendUrl') -or (Get-ObjectPropertyValue -Value $Value -Name 'devtools_frontend_url'))
        }
    }

    $output = [ordered]@{}
    $nodeName = [string](Get-ObjectPropertyValue -Value $Value -Name 'nodeName')
    foreach ($name in $names) {
        $key = [string]$name
        $entryValue = Get-ObjectPropertyValue -Value $Value -Name $key
        if ($key -match '^(accessToken|sessionToken|id_token|refresh_token|authorization|cookie|set-cookie|webSocketDebuggerUrl|web_socket_debugger_url|devtoolsFrontendUrl|devtools_frontend_url)$') {
            $output[$key] = '[redacted]'
        } elseif ($key -match '^(domSnapshot|dom_snapshot|rawDom|raw_dom|outerHTML|innerHTML|documentHTML|document_html)$' -or ($nodeName.ToUpperInvariant() -eq 'SCRIPT' -and $key -eq 'nodeValue')) {
            $output[$key] = '[redacted]'
        } else {
            $preserveArrayShape = $key -in @('selected_target_candidates', 'candidate_rejections', 'signals', 'selectors', 'matches')
            if ($preserveArrayShape -and $null -eq $entryValue) {
                $output[$key] = $null
            } elseif ($entryValue -is [System.Collections.IEnumerable] -and -not ($entryValue -is [string]) -and -not ($entryValue -is [System.Collections.IDictionary])) {
                $items = @()
                foreach ($item in $entryValue) { $items += ConvertTo-SafeBrowserAutomationOutput -Value $item }
                $output[$key] = [object[]]$items
            } elseif ($preserveArrayShape) {
                $output[$key] = [object[]]@(ConvertTo-SafeBrowserAutomationOutput -Value $entryValue)
            } else {
                $output[$key] = ConvertTo-SafeBrowserAutomationOutput -Value $entryValue
            }
        }
    }
    return [pscustomobject]$output
}

function ConvertTo-SafeBrowserAutomationJson {
    param([object]$Value, [int]$Depth = 30)
    return (ConvertTo-SafeBrowserAutomationOutput -Value $Value | ConvertTo-Json -Depth $Depth)
}

function Write-RestartState {
    param(
        [Parameter(Mandatory = $true)][string]$Generation,
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$Scope,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )

    Ensure-Directories
    $state = [ordered]@{
        generation = $Generation
        status = $Status
        mode = $Mode
        scope = $Scope
        at = (Get-Date).ToString('o')
        state_file = $RestartStateFile
        expected_surface_file = $ExpectedSurfaceFile
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }

    $json = ($state | ConvertTo-Json -Depth 30)
    $json | Set-Content -LiteralPath $RestartStateFile -Encoding utf8
    Write-SafeLogLine -Path $RestartLogFile -Text ($json -replace "`r?`n", ' ')
    Write-ServerLifecycleEvent -Operation 'restart' -Generation $Generation -Mode $Mode -Scope $Scope -Phase $Status -Status $Status -Ok ($Status -notin @('FAILED')) -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return [pscustomobject]$state
}

function Get-RestartState {
    if (-not (Test-Path -LiteralPath $RestartStateFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            status = 'never-run'
            state_file = $RestartStateFile
            expected_surface_file = $ExpectedSurfaceFile
        }
    }

    try {
        return (Get-Content -LiteralPath $RestartStateFile -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'state-file-unreadable'
            state_file = $RestartStateFile
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-WatchdogState {
    if (-not (Test-Path -LiteralPath $WatchdogStateFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            status = 'never-run'
            state_file = $WatchdogStateFile
            lock_file = $WatchdogLockFile
        }
    }

    try {
        return (Get-Content -LiteralPath $WatchdogStateFile -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'state-file-unreadable'
            state_file = $WatchdogStateFile
            lock_file = $WatchdogLockFile
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-StateFileFreshness {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxAgeSeconds = 120
    )

    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) {
        return [pscustomobject]@{ exists = $false; fresh = $false; age_seconds = $null; max_age_seconds = $MaxAgeSeconds; last_write_time = $null }
    }

    $ageSeconds = [Math]::Round(((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalSeconds, 3)
    return [pscustomobject]@{
        exists = $true
        fresh = [bool]($ageSeconds -le $MaxAgeSeconds)
        age_seconds = $ageSeconds
        max_age_seconds = $MaxAgeSeconds
        last_write_time = $item.LastWriteTime.ToString('o')
    }
}

function Get-WatchdogStateStatus {
    $state = Get-WatchdogState
    $freshness = Get-StateFileFreshness -Path $WatchdogStateFile -MaxAgeSeconds 120
    $ok = [bool]($state.ok -and $freshness.fresh)
    return [pscustomobject]@{
        ok = $ok
        status = if (-not $freshness.exists) { 'NEVER_RUN' } elseif (-not $freshness.fresh) { 'STALE' } else { [string]$state.status }
        freshness = $freshness
        state = $state
    }
}

function Invoke-AuthRuntimePostcondition {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [switch]$RequirePublic
    )

    $spec = if ($Kind -eq 'chatgpt') { Get-ChatgptSpec } else { Get-CodexSpec }
    $origin = if ($Kind -eq 'chatgpt') { $ChatgptOrigin } else { $CodexOrigin }
    $local = if ($Kind -eq 'chatgpt') { Invoke-ChatgptSmoke -Origin $origin -Label 'local-chatgpt' -Quiet } else { Invoke-CodexSmoke -Origin $origin -Label 'local-codex' -Quiet }
    $freshness = if ($Kind -eq 'chatgpt') { Get-ChatgptRuntimeFreshness } else { [pscustomobject]@{ ok = $true; status = 'NOT_APPLICABLE'; reasons = @() } }
    $processState = Get-ManagedProcessState -Spec $spec
    $public = if ($Kind -eq 'chatgpt' -and $RequirePublic) { Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet } else { $null }
    $publicOk = if ($RequirePublic -and $Kind -eq 'chatgpt') { $public.ok -eq $true } else { $true }
    $ok = [bool]($processState.running -and $processState.port_open -and $local.ok -eq $true -and $freshness.ok -eq $true -and $publicOk)

    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'AUTH_RUNTIME_GREEN' } else { 'AUTH_RUNTIME_RED' }
        kind = $Kind
        at = (Get-Date).ToString('o')
        process = $processState
        local = $local
        freshness = $freshness
        public = $public
        require_public = [bool]$RequirePublic
    }
}

function Assert-AuthRuntimePostcondition {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [switch]$RequirePublic
    )

    $postcondition = Invoke-AuthRuntimePostcondition -Kind $Kind -RequirePublic:$RequirePublic
    if (-not $postcondition.ok) {
        $publicOk = if ($postcondition.public) { $postcondition.public.ok } else { $null }
        throw ("Auth runtime postcondition failed. kind={0}; status={1}; process_running={2}; port_open={3}; local_ok={4}; freshness_ok={5}; public_ok={6}" -f $Kind, $postcondition.status, $postcondition.process.running, $postcondition.process.port_open, $postcondition.local.ok, $postcondition.freshness.ok, $publicOk)
    }
    return $postcondition
}

function Invoke-BrowserFreshPostcondition {
    param([string]$Purpose = 'postcondition')

    $recovery = $null
    try {
        $recovery = Invoke-BrowserEnsureVisible -Purpose $Purpose
    } catch {
        $recovery = [pscustomobject]@{ ok = $false; status = 'BROWSER_RECOVERY_FAILED'; error = Sanitize-Text $_.Exception.Message }
    }

    $health = Get-BrowserStackHealthReport
    $repair = Invoke-ChatgptSessionWarmthRepair -ConfirmRepair
    $warmth = $repair.after_warmth
    $browserGreen = [bool]($health.ok -eq $true)
    $warm = [bool]($warmth.ok -eq $true)
    return [pscustomobject]@{
        ok = [bool]($browserGreen -and $warm)
        status = if ($browserGreen -and -not $warm) { 'BROWSER_GREEN_CHATGPT_SESSION_NOT_WARM' } elseif ($browserGreen) { 'BROWSER_POSTCONDITION_GREEN' } else { 'BROWSER_POSTCONDITION_RED' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        recovery = $recovery
        health = $health
        chatgpt_session_warmth = $warmth
        chatgpt_session_warmth_repair = $repair
    }
}

function Assert-BrowserFreshPostcondition {
    param([string]$Purpose = 'postcondition')

    $postcondition = Invoke-BrowserFreshPostcondition -Purpose $Purpose
    if (-not $postcondition.ok) {
        throw ("Browser postcondition failed. purpose={0}; next_action={1}; visible_window_detected={2}; cdp_ok={3}; chatgpt_target_count={4}" -f $Purpose, $postcondition.health.next_action, $postcondition.health.microsoft_edge.visible_window_detected, $postcondition.health.cdp_9223.ok, $postcondition.health.target_inventory.chatgpt_target_count)
    }
    return $postcondition
}

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

function Write-WatchdogState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object[]]$Actions = @(),
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )

    Ensure-Directories
    $state = [ordered]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        state_file = $WatchdogStateFile
        lock_file = $WatchdogLockFile
        log_file = $WatchdogLogFile
        actions = @($Actions)
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $json = ($state | ConvertTo-Json -Depth 30)
    $json | Set-Content -LiteralPath $WatchdogStateFile -Encoding utf8
    Write-SafeLogLine -Path $WatchdogLogFile -Text ($json -replace "`r?`n", ' ')
    Write-ServerLifecycleEvent -Operation 'watchdog' -Phase $Status -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return [pscustomobject]$state
}

function Enter-WatchdogLock {
    Ensure-Directories
    $now = Get-Date
    if (Test-Path -LiteralPath $WatchdogLockFile -PathType Leaf) {
        $lockItem = Get-Item -LiteralPath $WatchdogLockFile -ErrorAction SilentlyContinue
        $lock = $null
        try {
            $lock = Get-Content -LiteralPath $WatchdogLockFile -Raw | ConvertFrom-Json
        } catch {
            $lock = $null
        }

        $lockPid = if ($lock -and $lock.pid) { [int]$lock.pid } else { $null }
        $lockProcess = if ($lockPid) { Get-Process -Id $lockPid -ErrorAction SilentlyContinue } else { $null }
        $lockAgeSeconds = if ($lockItem) { (($now.ToUniversalTime() - $lockItem.LastWriteTimeUtc).TotalSeconds) } else { 999999 }
        $lockIsFresh = [bool]($lockAgeSeconds -lt 300)
        $lockIsSelfOwned = [bool]($lockPid -eq $PID)
        $lockCommandLine = if ($lock -and $lock.command_line) { [string]$lock.command_line } else { '' }
        $lockClaimsWatchdogLoop = $lockCommandLine -match 'watchdog-loop-run'
        $registeredLoop = if ($lockClaimsWatchdogLoop) { Get-WatchdogLoopProcessState } else { $null }
        $lockIsRegisteredLoop = [bool]($registeredLoop -and $registeredLoop.running -and $registeredLoop.pid -and [int]$registeredLoop.pid -eq $lockPid)

        if ($lockIsFresh -and $lockProcess -and -not $lockIsSelfOwned -and (-not $lockClaimsWatchdogLoop -or $lockIsRegisteredLoop)) {
            return $false
        }

        Remove-Item -LiteralPath $WatchdogLockFile -Force -ErrorAction SilentlyContinue
    }

    $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        pid = $PID
        owner = 'watchdog-heal'
        session_id = (Get-Process -Id $PID).SessionId
        at = $now.ToString('o')
        heartbeat_at = $now.ToString('o')
        command_line = if ($currentProcess) { Sanitize-Text $currentProcess.CommandLine } else { $null }
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $WatchdogLockFile -Encoding utf8
    return $true
}

function Exit-WatchdogLock {
    if (-not (Test-Path -LiteralPath $WatchdogLockFile -PathType Leaf)) {
        return
    }

    $lock = $null
    try {
        $lock = Get-Content -LiteralPath $WatchdogLockFile -Raw | ConvertFrom-Json
    } catch {
        $lock = $null
    }

    if ($lock -and $lock.pid -and [int]$lock.pid -ne $PID) {
        return
    }

    Remove-Item -LiteralPath $WatchdogLockFile -Force -ErrorAction SilentlyContinue
}

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

function Resolve-CloudflaredExe {
    $candidates = @()

    if ($env:CONSOLE_MCP_CLOUDFLARED_BIN) {
        $candidates += $env:CONSOLE_MCP_CLOUDFLARED_BIN.Trim()
    }

    $candidates += 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    $candidates += 'C:\Tools\cloudflared\cloudflared.exe'

    $pathCommand = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($pathCommand) {
        $candidates += $pathCommand.Source
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    throw "cloudflared.exe was not found. Set CONSOLE_MCP_CLOUDFLARED_BIN, install it at C:\Tools\cloudflared\cloudflared.exe, or add it to PATH."
}

function Get-NpmCommand {
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmd) {
        return $npmCmd.Source
    }

    $npmExe = Get-Command npm.exe -ErrorAction SilentlyContinue
    if ($npmExe) {
        return $npmExe.Source
    }

    $npm = Get-Command npm -ErrorAction Stop
    return $npm.Source
}

function Get-NodeCommand {
    return (Get-Command node -ErrorAction Stop)
}

function Get-PwshCommand {
    return (Get-Command pwsh -ErrorAction Stop)
}

function Tail-ServerLog {
    $candidates = @()
    foreach ($path in @($ChatgptLogFile, "$ChatgptLogFile.err", $CodexLogFile, "$CodexLogFile.err")) {
        if (Test-Path -LiteralPath $path) {
            $candidates += Get-Item -LiteralPath $path
        }
    }

    if ($candidates.Count -eq 0) {
        Write-Output "No server logs found."
        return
    }

    $latest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Output "Tailing $($latest.FullName)"
    Get-Content -LiteralPath $latest.FullName -Tail 100 -Wait
}

function Show-AwsSecretStatus {
    try {
        $secret = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN' -WithSource
        $value = [string]$secret.value
        return ([pscustomobject]@{
            ok = -not [string]::IsNullOrWhiteSpace($value)
            status = if (-not [string]::IsNullOrWhiteSpace($value)) { 'BEARER_SECRET_AVAILABLE' } else { 'BEARER_SECRET_EMPTY' }
            secret_present = -not [string]::IsNullOrWhiteSpace($value)
            source = $secret.source
            secret_id = $secret.secret_id
        } | ConvertTo-Json -Depth 6)
    } catch {
        return ([pscustomobject]@{
            ok = $false
            status = 'AWS_SECRET_UNAVAILABLE'
            secret_present = $false
            secret_id = '/secret/dev/console-mcp/bearer-token'
            iam_credentials_required = $true
            diagnostic = Sanitize-Text $_.Exception.Message
        } | ConvertTo-Json -Depth 6)
    }
}

function Get-ConsoleBearerToken {
    $token = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN'
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "CONSOLE_MCP_BEARER_TOKEN must be set before starting or smoking the Codex bearer profile."
    }

    return $token.Trim()
}

function Get-ConsoleBearerTokenStatus {
    try {
        $secret = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN' -WithSource
        $present = -not [string]::IsNullOrWhiteSpace([string]$secret.value)
        return [pscustomobject]@{
            ok = $present
            status = if ($present) { 'BEARER_TOKEN_AVAILABLE' } else { 'BEARER_TOKEN_EMPTY' }
            present = $present
            source = $secret.source
            secret_id = $secret.secret_id
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'BEARER_TOKEN_UNAVAILABLE'
            present = $false
            source = 'unresolved'
            secret_id = if (-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_BEARER_SECRET_ID)) { $env:CONSOLE_MCP_BEARER_SECRET_ID.Trim() } else { '/secret/dev/console-mcp/bearer-token' }
            diagnostic = Sanitize-Text $_.Exception.Message
        }
    }
}

$AlertStateFile = Join-Path $RunDir 'console-mcp-last-alert.json'

function Send-WatchdogAlert {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Reason
    )

    # No Cloudflare/RDP dependency: plain outbound HTTPS to a Slack/Discord-style incoming
    # webhook and/or the Telegram Bot API, same network path already used for AWS calls.
    $webhookUrl = $env:CONSOLE_MCP_ALERT_WEBHOOK_URL
    $telegramToken = $env:CONSOLE_MCP_TELEGRAM_BOT_TOKEN
    $telegramChatId = $env:CONSOLE_MCP_TELEGRAM_CHAT_ID
    if ([string]::IsNullOrWhiteSpace($webhookUrl) -and ([string]::IsNullOrWhiteSpace($telegramToken) -or [string]::IsNullOrWhiteSpace($telegramChatId))) {
        return $false
    }

    $hostName = [System.Environment]::MachineName
    $text = "console-mcp [$hostName] ${Status}: $Reason"
    $sent = $false

    if (-not [string]::IsNullOrWhiteSpace($webhookUrl)) {
        try {
            Invoke-RestMethod -Uri $webhookUrl -Method Post -ContentType 'application/json' -Body (@{ text = $text } | ConvertTo-Json -Depth 4) -TimeoutSec 10 | Out-Null
            $sent = $true
        } catch {
            Write-Output (Sanitize-Text "Alert webhook failed: $($_.Exception.Message)")
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($telegramToken) -and -not [string]::IsNullOrWhiteSpace($telegramChatId)) {
        try {
            $telegramUrl = "https://api.telegram.org/bot$telegramToken/sendMessage"
            Invoke-RestMethod -Uri $telegramUrl -Method Post -Body @{ chat_id = $telegramChatId; text = $text } -TimeoutSec 10 | Out-Null
            $sent = $true
        } catch {
            Write-Output (Sanitize-Text "Alert telegram failed: $($_.Exception.Message)")
        }
    }

    return $sent
}

function Invoke-WatchdogAlertIfNeeded {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [string]$Reason = ''
    )

    # Alert only on real trouble, and de-duplicate: re-notify only if the status changed
    # since the last alert, or 30+ minutes passed with the same bad status (heartbeat).
    if ($Ok) {
        Remove-Item -LiteralPath $AlertStateFile -Force -ErrorAction SilentlyContinue
        return
    }

    $now = Get-Date
    $last = $null
    if (Test-Path -LiteralPath $AlertStateFile) {
        try { $last = Get-Content -LiteralPath $AlertStateFile -Raw | ConvertFrom-Json } catch { $last = $null }
    }

    $shouldAlert = $true
    if ($last -and [string]$last.status -eq $Status -and $last.at) {
        try {
            $minutesSince = ($now.ToUniversalTime() - [datetime]::Parse([string]$last.at).ToUniversalTime()).TotalMinutes
            if ($minutesSince -lt 30) { $shouldAlert = $false }
        } catch { $shouldAlert = $true }
    }

    if ($shouldAlert) {
        $sent = Send-WatchdogAlert -Status $Status -Reason $Reason
        if ($sent) {
            [pscustomobject]@{ status = $Status; at = $now.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $AlertStateFile -Encoding utf8
        }
    }
}

function Invoke-EngineCli {
    param([string[]]$Arguments = @())
    Ensure-Directories
    $node = Get-NodeCommand
    $engineScript = Join-Path $Root 'dist/engine/engine-cli.js'
    if (-not (Test-Path -LiteralPath $engineScript -PathType Leaf)) { Ensure-BuildOutput | Out-Null }
    $effectiveArgs = @($Arguments | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($effectiveArgs.Count -eq 0) { $effectiveArgs = @('status') }
    $engineLogDir = Join-Path $LogDir 'engine'
    $engineShellLog = Join-Path $engineLogDir 'shell.jsonl'
    New-Item -ItemType Directory -Force -Path $engineLogDir | Out-Null
    $entry = [ordered]@{ ts = (Get-Date).ToString('o'); source = 'dev-console'; command = 'engine'; args = $effectiveArgs; root = $Root }
    Write-SafeLogLine -Path $engineShellLog -Text (($entry | ConvertTo-Json -Depth 8 -Compress))
    Push-Location $Root
    try {
        & $node.Source --enable-source-maps $engineScript @effectiveArgs
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($exitCode -ne 0) { throw "engine CLI failed with exit code $exitCode" }
}

# ChatGPT session CLI and lifecycle prompt orchestration are owned by tool/dev-console.d/61-chatgpt-session.ps1.
function Get-ConfiguredSecretValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$WithSource
    )

    $expectedName = 'CONSOLE_MCP_' + 'BEARER_' + 'TOKEN'
    if ($Name -ne $expectedName) {
        if ($WithSource) {
            return [pscustomobject]@{ value = $null; source = 'unsupported'; secret_id = $null }
        }
        return $null
    }

    $processValue = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        $value = $processValue.Trim()
        if ($WithSource) {
            return [pscustomobject]@{ value = $value; source = 'env:Process'; secret_id = $null }
        }
        return $value
    }

    $userValue = [System.Environment]::GetEnvironmentVariable($Name, 'User')
    if (-not [string]::IsNullOrWhiteSpace($userValue)) {
        $value = $userValue.Trim()
        if ($WithSource) {
            return [pscustomobject]@{ value = $value; source = 'env:User'; secret_id = $null }
        }
        return $value
    }

    $machineValue = [System.Environment]::GetEnvironmentVariable($Name, 'Machine')
    if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
        $value = $machineValue.Trim()
        if ($WithSource) {
            return [pscustomobject]@{ value = $value; source = 'env:Machine'; secret_id = $null }
        }
        return $value
    }

    $secretId = if (-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_BEARER_SECRET_ID)) { $env:CONSOLE_MCP_BEARER_SECRET_ID.Trim() } else { '/secret/dev/console-mcp/' + 'bearer-token' }
    $aws = Get-Command aws -ErrorAction Stop
    $output = & $aws.Source secretsmanager get-secret-value --secret-id $secretId --query SecretString --output text 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("Unable to read configured secret from AWS Secrets Manager: {0}" -f (Sanitize-Text (($output | Out-String).Trim())))
    }

    $text = (($output | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($text) -or $text -eq 'None') {
        if ($WithSource) {
            return [pscustomobject]@{ value = $null; source = 'aws-secrets-manager'; secret_id = $secretId }
        }
        return $null
    }

    $resolvedValue = $text
    if ($text.StartsWith('{')) {
        try {
            $json = $text | ConvertFrom-Json
            foreach ($key in @($Name, 'value', 'token', 'apiToken', 'secret')) {
                if ($json.PSObject.Properties.Name -contains $key) {
                    $candidate = [string]$json.$key
                    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                        $resolvedValue = $candidate.Trim()
                        if ($WithSource) {
                            return [pscustomobject]@{ value = $resolvedValue; source = 'aws-secrets-manager'; secret_id = $secretId }
                        }
                        return $resolvedValue
                    }
                }
            }
        } catch {
            $resolvedValue = $text
        }
    }

    if ($WithSource) {
        return [pscustomobject]@{ value = $resolvedValue; source = 'aws-secrets-manager'; secret_id = $secretId }
    }
    return $resolvedValue
}

$DevConsoleModuleDir = Join-Path $PSScriptRoot 'dev-console.d'
if (Test-Path -LiteralPath $DevConsoleModuleDir -PathType Container) {
    Get-ChildItem -LiteralPath $DevConsoleModuleDir -Filter '*.ps1' -File | Where-Object { $_.Name -ne '23-browser-relaunch.ps1' } | Sort-Object Name | ForEach-Object { . $_.FullName }
}

function Get-InteractiveDesktopCapabilityLease {
    param([switch]$RequireVisibleWindow)
    $health = Get-BrowserStackHealthReport
    $consoleSession = Get-ConsoleSessionReport
    $currentSessionId = $null
    try { $currentSessionId = (Get-Process -Id $PID).SessionId } catch { $currentSessionId = $null }
    $activeConsoleSessionId = if ($consoleSession.active_console) { [int]$consoleSession.active_console.id } else { $null }
    $sessionMatches = [bool]($activeConsoleSessionId -ne $null -and $currentSessionId -eq $activeConsoleSessionId)
    $explorer = if ($activeConsoleSessionId -ne $null) { @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Where-Object { [int]$_.SessionId -eq $activeConsoleSessionId }) } else { @() }
    $edge = if ($activeConsoleSessionId -ne $null) { @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { [int]$_.SessionId -eq $activeConsoleSessionId }) } else { @() }
    $visibleOk = [bool](-not $RequireVisibleWindow -or $health.microsoft_edge.visible_window_detected)
    $ok = [bool]($consoleSession.ok -and $sessionMatches -and $explorer.Count -gt 0 -and $edge.Count -gt 0 -and $health.cdp_9223.ok -and $health.target_inventory.chatgpt_target_count -gt 0 -and $visibleOk)
    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'INTERACTIVE_DESKTOP_LEASE_READY' } else { 'INTERACTIVE_DESKTOP_LEASE_UNAVAILABLE' }
        current_session_id = $currentSessionId
        active_console_session_id = $activeConsoleSessionId
        session_matches = $sessionMatches
        explorer_count = $explorer.Count
        edge_count = $edge.Count
        require_visible_window = [bool]$RequireVisibleWindow
        browser = $health
    }
}

function Invoke-BrowserRelaunchVisible {
    param([string]$Purpose = 'manual')

    $lease = Get-InteractiveDesktopCapabilityLease -RequireVisibleWindow
    if (-not $lease.ok) {
        throw ("Browser relaunch blocked: interactive desktop lease unavailable. current_session_id={0}; active_console_session_id={1}; explorer_count={2}; edge_count={3}" -f $lease.current_session_id, $lease.active_console_session_id, $lease.explorer_count, $lease.edge_count)
    }
    $before = Get-BrowserStackHealthReport
    $consoleSession = Get-ConsoleSessionReport
    $currentSessionId = (Get-Process -Id $PID).SessionId
    $activeConsoleSessionId = if ($consoleSession.active_console) { [int]$consoleSession.active_console.id } else { $null }
    if ($before.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED' -and ($activeConsoleSessionId -eq $null -or $currentSessionId -ne $activeConsoleSessionId)) {
        throw ("Browser relaunch requires an interactive desktop session. This process is running in Windows session {1}, but the active console (interactive desktop) session is {2}. Re-run this command from a PowerShell/Windows Terminal window opened directly in the interactive desktop session (locally, or via RDP as the same Windows user) rather than via remoting/services/scheduled tasks/SSH; verify with 'query session' that your terminal's row shows 'console'+'Active' with ID {2}. " +
            "next_action={0}; current_session_id={1}; active_console_session_id={2}" -f $before.next_action, $currentSessionId, $activeConsoleSessionId)
    }
    $profilePlan = Resolve-BrowserUserDataDir
    $portPattern = '--remote-debugging-port=9223'
    $profilePattern = [string]$profilePlan.path
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    $matched = @()
    $stopped = @()
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        $matchesPort = $commandLine.Contains($portPattern)
        $matchesProfile = (-not [string]::IsNullOrWhiteSpace($profilePattern)) -and $commandLine.Contains($profilePattern)
        if ($matchesPort -or $matchesProfile) {
            $matched += $process
            try {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
                $stopped += [pscustomobject]@{ pid = $process.ProcessId; session_id = $process.SessionId; stopped = $true; matched_port = $matchesPort; matched_profile = $matchesProfile }
            } catch {
                $stopped += [pscustomobject]@{ pid = $process.ProcessId; session_id = $process.SessionId; stopped = $false; matched_port = $matchesPort; matched_profile = $matchesProfile; error = Sanitize-Text $_.Exception.Message }
            }
        }
    }

    Start-Sleep -Seconds 2
    $started = Start-VisibleEdge
    $after = Get-BrowserStackHealthReport
    if (-not $after.ok) {
        foreach ($attempt in 1..10) {
            Start-Sleep -Seconds 1
            $after = Get-BrowserStackHealthReport
            if ($after.ok) { break }
        }
    }

    $result = [pscustomobject]@{
        ok = [bool]$after.ok
        status = if ($after.ok) { 'BROWSER_RELAUNCHED' } else { 'BROWSER_RELAUNCH_UNHEALTHY' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        before = $before
        profile_plan = $profilePlan
        stop = [pscustomobject]@{ port = 9223; matched_count = $matched.Count; stopped = $stopped }
        started = $started
        after = $after
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "browser-relaunch-$Purpose") -Payload $result | Out-Null
    if (-not $result.ok) { throw "Browser relaunch failed. next_action=$($after.next_action)" }
    return $result
}

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














