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
function Get-CommandStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Resolver
    )

    try {
        $resolved = & $Resolver
        $version = $null
        try {
            $version = (& $resolved --version 2>$null | Select-Object -First 1)
        } catch {
            $version = $null
        }

        return [pscustomobject]@{
            name = $Name
            available = $true
            source = if ($resolved -is [string]) { $resolved } else { $resolved.Source }
            version = if ($version) { Sanitize-Text ([string]$version) } else { $null }
        }
    } catch {
        return [pscustomobject]@{
            name = $Name
            available = $false
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-CommonPrereqReport {
    $node = Get-CommandStatus -Name 'node' -Resolver { Get-NodeCommand }
    $npm = Get-CommandStatus -Name 'npm' -Resolver { Get-NpmCommand }
    $pwsh = Get-CommandStatus -Name 'pwsh' -Resolver { Get-PwshCommand }
    $repoRootExists = Test-Path -LiteralPath $Root
    $buildOutput = Get-BuildOutputReport

    [pscustomobject]@{
        repo_root = $Root
        repo_root_exists = $repoRootExists
        node = $node
        npm = $npm
        pwsh = $pwsh
        build_output = $buildOutput
    }
}

function Get-ConfigReport {
    $workspaceRoot = Get-WorkspaceRoot
    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)

    [pscustomobject]@{
        auth_mode_chatgpt = 'oauth'
        auth_mode_codex = 'bearer'
        workspace_root_default = $DefaultWorkspaceRoot
        workspace_root_effective = $workspaceRoot
        workspace_root_source = if ($env:CONSOLE_MCP_WORKSPACE_ROOT) { 'env' } else { 'default' }
        chatgpt_port = [pscustomobject]@{
            port = 3333
            running = $chatgptState.running
            port_open = $chatgptState.port_open
            pid = $chatgptState.pid
        }
        codex_port = [pscustomobject]@{
            port = 3334
            running = $codexState.running
            port_open = $codexState.port_open
            pid = $codexState.pid
        }
    }
}

function Get-CloudflaredReport {
    $configExists = Test-Path -LiteralPath $CloudflaredConfig
    $resolved = $null
    $resolutionError = $null
    try {
        $resolved = Resolve-CloudflaredExe
    } catch {
        $resolutionError = Sanitize-Text $_.Exception.Message
    }

    $credentialFile = $null
    $credentialFileExists = $null
    $configParseOk = $false
    if ($configExists) {
        try {
            $configText = Get-Content -LiteralPath $CloudflaredConfig -Raw
            $credentialMatch = [regex]::Match($configText, 'credentials-file:\s*(?<path>.+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($credentialMatch.Success) {
                $credentialFile = $credentialMatch.Groups['path'].Value.Trim()
                $configParseOk = $true
                if ($credentialFile -notmatch '<') {
                    $credentialFileExists = Test-Path -LiteralPath $credentialFile
                }
            }
        } catch {
            $resolutionError = Sanitize-Text $_.Exception.Message
        }
    }

    [pscustomobject]@{
        config_file = $CloudflaredConfig
        config_exists = $configExists
        config_parse_ok = $configParseOk
        binary = $resolved
        binary_resolved = [bool]$resolved
        binary_error = $resolutionError
        credential_file = $credentialFile
        credential_file_exists = $credentialFileExists
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ConsoleSessionReport {
    $sessions = @()
    $activeConsole = $null
    $reasons = @()
    try {
        foreach ($line in @(query session 2>$null | Select-Object -Skip 1)) {
            $text = (([string]$line).Trim() -replace '^>', '') -replace '\s+', ' '
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $parts = @($text -split ' ' | Where-Object { $_ })
            $idIndex = -1
            for ($i = 0; $i -lt $parts.Count; $i++) {
                $n = 0
                if ([int]::TryParse($parts[$i], [ref]$n)) { $idIndex = $i; break }
            }
            if ($idIndex -lt 0) { continue }
            $sessionName = $parts[0]
            $username = if ($idIndex -ge 2) { $parts[1] } else { $null }
            $state = if ($parts.Count -gt ($idIndex + 1)) { $parts[$idIndex + 1] } else { $null }
            $record = [pscustomobject]@{ session_name = $sessionName; username = $username; id = [int]$parts[$idIndex]; state = $state; is_console = ($sessionName -ieq 'console'); is_active = ($state -match '^(Active|Активно)$') }
            $sessions += $record
            if ($record.is_console -and $record.is_active) { $activeConsole = $record }
        }
    } catch {
        $reasons += 'session_query_failed'
    }
    if (-not $activeConsole) { $reasons += 'active_console_session_missing' }
    $expectedUser = $env:USERNAME
    if ($activeConsole -and $activeConsole.username -and $activeConsole.username -ine $expectedUser) { $reasons += 'active_console_user_mismatch' }
    $ok = [bool]($activeConsole -and ($activeConsole.username -ieq $expectedUser -or [string]::IsNullOrWhiteSpace($activeConsole.username)))
    return [pscustomobject]@{ ok = $ok; status = if ($ok) { 'CONSOLE_SESSION_READY' } else { 'CONSOLE_SESSION_NOT_READY' }; expected_user = $expectedUser; active_console = $activeConsole; session_count = @($sessions).Count; sessions = @($sessions); reasons = $reasons }
}

function Get-AutologonReport {
    $path = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $item = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
    if (-not $item) {
        return [pscustomobject]@{
            ok = $false
            status = 'AUTOLOGON_REGISTRY_UNREADABLE'
            registry_path = $path
            enabled = $false
            default_user_name = $null
            default_domain_name = $null
            password_present = $false
            expected_identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            reasons = @('winlogon_registry_unreadable')
        }
    }

    $enabled = [string]$item.AutoAdminLogon -eq '1'
    $defaultUserName = [string]$item.DefaultUserName
    $defaultDomainName = [string]$item.DefaultDomainName
    $passwordPresent = -not [string]::IsNullOrWhiteSpace([string]$item.DefaultPassword)
    $expectedIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $expectedUser = $env:USERNAME
    $expectedComputer = $env:COMPUTERNAME
    $userMatches = -not [string]::IsNullOrWhiteSpace($defaultUserName) -and ($defaultUserName -ieq $expectedUser -or $expectedIdentity -like "*$defaultUserName")
    $domainMatches = [string]::IsNullOrWhiteSpace($defaultDomainName) -or $defaultDomainName -ieq $expectedComputer -or $expectedIdentity -like "$defaultDomainName\*"
    $reasons = @()
    if (-not $enabled) { $reasons += 'auto_admin_logon_disabled' }
    if (-not $userMatches) { $reasons += 'default_user_mismatch_or_missing' }
    if (-not $domainMatches) { $reasons += 'default_domain_mismatch' }
    if (-not $passwordPresent) { $reasons += 'default_password_not_in_winlogon_registry' }

    $ok = [bool]($enabled -and $userMatches -and $domainMatches)
    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { if ($passwordPresent) { 'AUTOLOGON_READY' } else { 'AUTOLOGON_READY_PASSWORD_STORAGE_NOT_REGISTRY' } } else { 'AUTOLOGON_NOT_READY' }
        registry_path = $path
        enabled = $enabled
        default_user_name = if ([string]::IsNullOrWhiteSpace($defaultUserName)) { $null } else { $defaultUserName }
        default_domain_name = if ([string]::IsNullOrWhiteSpace($defaultDomainName)) { $null } else { $defaultDomainName }
        password_present = $passwordPresent
        expected_identity = $expectedIdentity
        expected_user = $expectedUser
        expected_computer = $expectedComputer
        user_matches = $userMatches
        domain_matches = $domainMatches
        reasons = $reasons
    }
}

function Get-TailscaleReport {
    $cim = $null
    $service = $null
    $cli = $null
    $cliStatus = $null
    $cliExitCode = $null
    $cliError = $null

    try {
        $cim = Get-CimInstance Win32_Service -Filter "Name='Tailscale'" -ErrorAction Stop |
            Select-Object Name, State, StartMode, StartName, PathName
    } catch {
        $cim = $null
    }

    try {
        $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue |
            Select-Object Name, Status, StartType
    } catch {
        $service = $null
    }

    $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($tailscale) {
        $cli = [pscustomobject]@{
            exists = $true
            source = $tailscale.Source
        }

        try {
            $output = & $tailscale.Source status 2>&1
            $cliExitCode = $LASTEXITCODE
            $cliStatus = Sanitize-Text (($output | Out-String).Trim())
        } catch {
            $cliExitCode = $LASTEXITCODE
            $cliError = Sanitize-Text $_.Exception.Message
        }
    } else {
        $cli = [pscustomobject]@{
            exists = $false
            source = $null
        }
        $cliStatus = 'tailscale.exe not found in PATH'
    }

    $installed = $null -ne $service
    $automatic = $installed -and ([string]$service.StartType -eq 'Automatic' -or [string]$cim.StartMode -eq 'Auto')
    $running = $installed -and [string]$service.Status -eq 'Running'
    $cliOk = $cli.exists -and $cliExitCode -eq 0

    return [pscustomobject]@{
        service_cim = $cim
        service = $service
        cli = $cli
        cli_status = $cliStatus
        cli_exit_code = $cliExitCode
        cli_error = $cliError
        installed = $installed
        autostart_automatic = $automatic
        running = $running
        cli_status_ok = $cliOk
        ok = $installed -and $automatic -and $running -and $cliOk
    }
}

function Invoke-TailscaleAutostartEnforcement {
    $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
    if (-not $service) {
        return [pscustomobject]@{
            ok = $false
            blocked = $true
            message = 'BLOCKED: Tailscale service not found.'
            admin_command = $null
            report = Get-TailscaleReport
        }
    }

    if (Test-IsAdministrator) {
        Set-Service -Name Tailscale -StartupType Automatic
        Start-Service -Name Tailscale -ErrorAction SilentlyContinue
        return [pscustomobject]@{
            ok = $true
            blocked = $false
            message = 'OK: Tailscale service set to Automatic and start attempted.'
            admin_command = $null
            report = Get-TailscaleReport
        }
    }

    return [pscustomobject]@{
        ok = $false
        blocked = $true
        message = 'BLOCKED: Shell is not elevated. Run as Administrator:'
        admin_command = 'Set-Service -Name Tailscale -StartupType Automatic; Start-Service -Name Tailscale'
        report = Get-TailscaleReport
    }
}

function Get-AutostartSummary {
    $startupTask = Show-StartupTask | ConvertFrom-Json
    $tailscale = Get-TailscaleReport

    $autologon = Get-AutologonReport
    $consoleSession = Get-ConsoleSessionReport

    return [pscustomobject]@{
        console_mcp_startup_task_installed = [bool]$startupTask.exists
        autologon_ready = [bool]$autologon.ok
        console_session_ready = [bool]$consoleSession.ok
        tailscale_service_installed = [bool]$tailscale.installed
        tailscale_autostart_automatic = [bool]$tailscale.autostart_automatic
        tailscale_running = [bool]$tailscale.running
        tailscale_cli_status_ok = [bool]$tailscale.cli_status_ok
        ok = [bool]$startupTask.exists -and [bool]$autologon.ok -and [bool]$consoleSession.ok -and [bool]$tailscale.installed -and [bool]$tailscale.autostart_automatic -and [bool]$tailscale.running -and [bool]$tailscale.cli_status_ok
        autologon = $autologon
        console_session = $consoleSession
        tailscale = $tailscale
        startup_task = $startupTask
    }
}

function Format-AutostartCompactSummary {
    param([Parameter(Mandatory = $true)]$Summary)

    $status = if ($Summary.ok) { 'PASS' } else { 'BLOCKED' }
    return @(
        "autostart_summary: $status"
        "Console MCP startup task installed? $($Summary.console_mcp_startup_task_installed)"
        "Windows autologon ready? $($Summary.autologon_ready)"
        "Active console session ready? $($Summary.console_session_ready)"
        "Tailscale service installed? $($Summary.tailscale_service_installed)"
        "Tailscale autostart Automatic? $($Summary.tailscale_autostart_automatic)"
        "Tailscale running? $($Summary.tailscale_running)"
        "Tailscale CLI status ok? $($Summary.tailscale_cli_status_ok)"
    ) -join [Environment]::NewLine
}

function Write-DesktopReloginTransaction {
    param([Parameter(Mandatory = $true)]$State)
    $temporary = "$DesktopReloginStateFile.$PID.tmp"
    $State | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $DesktopReloginStateFile -Force
}

function Complete-PendingDesktopReloginTransaction {
    if (-not (Test-Path -LiteralPath $DesktopReloginStateFile -PathType Leaf)) {
        return [pscustomobject]@{ ok = $true; status = 'NO_PENDING_DESKTOP_RELOGIN' }
    }
    try { $state = Get-Content -LiteralPath $DesktopReloginStateFile -Raw | ConvertFrom-Json -Depth 30 } catch {
        return [pscustomobject]@{ ok = $false; status = 'DESKTOP_RELOGIN_STATE_UNREADABLE'; error = Sanitize-Text $_.Exception.Message }
    }
    if ($state.status -eq 'POST_LOGIN_COMPLETED') { return $state }

    $after = Get-ConsoleSessionReport
    $browser = Get-BrowserStackHealthReport
    $newSessionId = if ($after.active_console) { [int]$after.active_console.id } else { $null }
    $newEpoch = if ($after.active_console) { "session:$newSessionId" } else { $null }
    $sessionReplaced = [bool]($newSessionId -ne $null -and $newSessionId -ne [int]$state.old_session_id)
    $ok = [bool]($after.ok -and $sessionReplaced -and $browser.ok)
    $state.status = if ($ok) { 'POST_LOGIN_COMPLETED' } else { 'POST_LOGIN_PENDING' }
    $state.completed_at = if ($ok) { (Get-Date).ToUniversalTime().ToString('o') } else { $null }
    $state.new_session_id = $newSessionId
    $state.new_login_epoch = $newEpoch
    $state.after = $after
    $state.browser = $browser
    Write-DesktopReloginTransaction -State $state
    return $state
}

function Invoke-DesktopRelogin {
    $before = Get-ConsoleSessionReport
    $autologon = Get-AutologonReport
    if (-not $autologon.ok) {
        throw "Desktop relogin blocked: autologon is not ready. status=$($autologon.status)"
    }
    if (-not $before.ok -or -not $before.active_console) {
        throw "Desktop relogin blocked: active console session is not ready."
    }

    $sessionId = [int]$before.active_console.id
    $state = [pscustomobject]@{
        schema_version = 2
        generation = [guid]::NewGuid().ToString('N')
        ok = $false
        status = 'PRE_LOGOUT_ARMED'
        requested_at = (Get-Date).ToUniversalTime().ToString('o')
        requested_by_pid = $PID
        old_session_id = $sessionId
        old_login_epoch = "session:$sessionId"
        autologon = $autologon
        before = $before
        completed_at = $null
        new_session_id = $null
        new_login_epoch = $null
        next_action = 'post-login task completes this durable transaction; poll desktop-relogin-transaction.json from SSH'
    }
    Write-DesktopReloginTransaction -State $state
    & logoff.exe $sessionId
    return ($state | ConvertTo-Json -Depth 30)
}

function Invoke-PreSignoutValidation {
    $enforcement = Invoke-TailscaleAutostartEnforcement
    $summary = Get-AutostartSummary
    return [pscustomobject]@{
        phase = 'phase_2_pre_signout'
        tailscale_enforcement = $enforcement
        autostart_summary = $summary
        compact_summary = Format-AutostartCompactSummary -Summary $summary
    } | ConvertTo-Json -Depth 12
}

function Invoke-PostLoginValidation {
    $summary = Get-AutostartSummary
    $relogin = Complete-PendingDesktopReloginTransaction
    return [pscustomobject]@{
        phase = 'phase_3_post_login'
        autostart_summary = $summary
        desktop_relogin = $relogin
        compact_summary = Format-AutostartCompactSummary -Summary $summary
    } | ConvertTo-Json -Depth 20
}

function Get-DesktopAgentHeartbeatLoopIntervalSeconds {
    $configured = $env:CONSOLE_MCP_DESKTOP_AGENT_HEARTBEAT_SECONDS
    $parsed = 0
    if ($configured -and [int]::TryParse($configured, [ref]$parsed) -and $parsed -ge 5 -and $parsed -le 300) { return $parsed }
    return 30
}

function Invoke-DesktopAgentHeartbeatLoop {
    Ensure-Directories
    Set-Content -LiteralPath $DesktopAgentLoopPidFile -Value $PID -NoNewline
    while ($true) {
        try {
            $heartbeat = Write-DesktopAgentHeartbeat | ConvertFrom-Json
            $record = [pscustomobject]@{ at = (Get-Date).ToString('o'); ok = $heartbeat.devtools_ok -and $heartbeat.chatgpt_target; status = 'HEARTBEAT'; heartbeat = $heartbeat }
            Write-SafeLogLine -Path $DesktopAgentLoopLogFile -Text ($record | ConvertTo-Json -Depth 8 -Compress)
        } catch {
            $record = [pscustomobject]@{ at = (Get-Date).ToString('o'); ok = $false; status = 'HEARTBEAT_FAILED'; error = Sanitize-Text $_.Exception.Message }
            Write-SafeLogLine -Path $DesktopAgentLoopLogFile -Text ($record | ConvertTo-Json -Depth 8 -Compress)
        }
        Start-Sleep -Seconds (Get-DesktopAgentHeartbeatLoopIntervalSeconds)
    }
}

function Get-DesktopAgentLoopProcessState {
    $loopPid = Get-ManagedPid -PidFile $DesktopAgentLoopPidFile
    $alive = $loopPid -and (Test-ManagedPid -ProcessId $loopPid)
    $process = if ($alive) { Get-CimInstance Win32_Process -Filter "ProcessId = $loopPid" -ErrorAction SilentlyContinue } else { $null }
    $heartbeat = if (Test-Path -LiteralPath $DesktopAgentStateFile -PathType Leaf) { try { Get-Content -LiteralPath $DesktopAgentStateFile -Raw | ConvertFrom-Json } catch { $null } } else { $null }
    return [pscustomobject]@{
        name = 'console-mcp-desktop-agent-heartbeat-loop'
        pid_file = $DesktopAgentLoopPidFile
        pid = if ($alive) { $loopPid } else { $null }
        running = [bool]$alive
        stale_pid_file = [bool]($loopPid -and -not $alive)
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        state_file = $DesktopAgentStateFile
        log_file = $DesktopAgentLoopLogFile
        interval_seconds = Get-DesktopAgentHeartbeatLoopIntervalSeconds
        heartbeat = $heartbeat
    }
}

function Start-DesktopAgentLoop {
    Ensure-Directories
    $state = Get-DesktopAgentLoopProcessState
    if ($state.running) { return ($state | ConvertTo-Json -Depth 12) }
    Remove-Item -LiteralPath $DesktopAgentLoopPidFile -Force -ErrorAction SilentlyContinue
    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    $process = Start-Process -FilePath $pwsh.Source -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, 'desktop-agent-heartbeat-loop') -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput ($DesktopAgentLoopLogFile + '.stdout.log') -RedirectStandardError ($DesktopAgentLoopLogFile + '.stderr.log')
    Set-Content -LiteralPath $DesktopAgentLoopPidFile -Value $process.Id -NoNewline
    Start-Sleep -Milliseconds 750
    return (Get-DesktopAgentLoopProcessState | ConvertTo-Json -Depth 12)
}

function Stop-DesktopAgentLoop {
    $state = Get-DesktopAgentLoopProcessState
    if ($state.pid) {
        try { Stop-Process -Id ([int]$state.pid) -Force -ErrorAction Stop } catch { }
        foreach ($attempt in 1..20) {
            if (-not (Test-ManagedPid -ProcessId ([int]$state.pid))) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    Remove-Item -LiteralPath $DesktopAgentLoopPidFile -Force -ErrorAction SilentlyContinue
    return (Get-DesktopAgentLoopProcessState | ConvertTo-Json -Depth 12)
}

function Get-DesktopAgentInstallTaskPlan {
    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    return [pscustomobject]@{
        ok = $true
        status = 'DESKTOP_AGENT_INSTALL_TASK_PLAN_READY'
        dry_run = $true
        task_name = $DesktopAgentTaskName
        task_path = $StartupTaskPath
        execute = $pwsh.Source
        arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" desktop-agent-heartbeat-loop"
        working_directory = $Root
        trigger = 'AtLogOn'
        principal_user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        logon_type = 'Interactive'
        run_level = 'Limited'
        rule = 'Run only when user is logged on; do not use session 0 for browser UI recovery.'
        writes = @()
    } | ConvertTo-Json -Depth 8
}

function Get-DoctorReport {
    $prereq = Get-CommonPrereqReport
    $config = Get-ConfigReport
    $cloudflared = Get-CloudflaredReport
    $bearerSecret = Get-ConsoleBearerTokenStatus
    $status = [pscustomobject]@{
        chatgpt_oauth = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        codex_bearer = Get-ManagedProcessState -Spec (Get-CodexSpec)
        codex_bearer_secret = $bearerSecret
        tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        smoke = [pscustomobject]@{
            local_chatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
            local_codex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
            public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        }
    }

    [pscustomobject]@{
        prereq = $prereq
        config = $config
        cloudflared = $cloudflared
        tailscale = Get-TailscaleReport
        autologon = Get-AutologonReport
        console_session = Get-ConsoleSessionReport
        autostart = Get-AutostartSummary
        status = $status
    }
}

function Show-Doctor {
    $report = Get-DoctorReport
    $summary = @(
        "repo_root: $($report.prereq.repo_root)"
        "repo_root_exists: $($report.prereq.repo_root_exists)"
        "node: $([bool]$report.prereq.node.available)"
        "npm: $([bool]$report.prereq.npm.available)"
        "pwsh: $([bool]$report.prereq.pwsh.available)"
        "dist_index_exists: $($report.prereq.build_output.dist_index.exists)"
        "build_needed: $($report.prereq.build_output.build_needed)"
        "workspace_root_effective: $($report.config.workspace_root_effective)"
        "chatgpt_oauth_port_3333: running=$($report.config.chatgpt_port.running) port_open=$($report.config.chatgpt_port.port_open)"
        "codex_bearer_port_3334: running=$($report.config.codex_port.running) port_open=$($report.config.codex_port.port_open)"
        "cloudflared_binary_resolved: $($report.cloudflared.binary_resolved)"
        "cloudflared_config_exists: $($report.cloudflared.config_exists)"
        "cloudflared_credential_file_exists: $($report.cloudflared.credential_file_exists)"
        "windows_autologon_ready: $($report.autologon.ok)"
        "windows_autologon_status: $($report.autologon.status)"
        "console_session_ready: $($report.console_session.ok)"
        "console_session_status: $($report.console_session.status)"
        "local_chatgpt_smoke_ok: $($report.status.smoke.local_chatgpt.ok)"
        "local_codex_smoke_ok: $($report.status.smoke.local_codex.ok)"
        "public_smoke_ok: $($report.status.smoke.public.ok)"
        "chatgpt_connector_refresh_status: $(if ($report.status.chatgpt_connector_refresh) { $report.status.chatgpt_connector_refresh.status } else { 'never-run' })"
        "chatgpt_connector_refresh_ok: $(if ($report.status.chatgpt_connector_refresh) { $report.status.chatgpt_connector_refresh.ok } else { $false })"
        "Tailscale service installed? $($report.autostart.tailscale_service_installed)"
        "Tailscale autostart Automatic? $($report.autostart.tailscale_autostart_automatic)"
        "Tailscale running? $($report.autostart.tailscale_running)"
        "Tailscale CLI status ok? $($report.autostart.tailscale_cli_status_ok)"
    )

    $summary -join [Environment]::NewLine
}

function Show-DoctorJson {
    return (Get-DoctorReport | ConvertTo-Json -Depth 10)
}

function Check-Prereq {
    return (Get-CommonPrereqReport | ConvertTo-Json -Depth 8)
}

function Check-Config {
    return (Get-ConfigReport | ConvertTo-Json -Depth 8)
}

function Check-Cloudflared {
    param([switch]$FailOnMissing)

    $report = Get-CloudflaredReport
    if ($FailOnMissing -and -not $report.binary_resolved) {
        throw "cloudflared.exe was not found. Set CONSOLE_MCP_CLOUDFLARED_BIN, install it at C:\Tools\cloudflared\cloudflared.exe, or add it to PATH."
    }

    return ($report | ConvertTo-Json -Depth 8)
}

function Install-StartupTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop

    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    $action = New-ScheduledTaskAction -Execute $pwsh.Source -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" $StartupTaskCommand" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $description = 'Start the console-mcp local stack for ChatGPT OAuth, Codex bearer, and optional tunnel.'

    Register-ScheduledTask -TaskName $StartupTaskName -TaskPath $StartupTaskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
    return Show-StartupTask
}

function Uninstall-StartupTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop

    $existing = Get-ScheduledTask -TaskName $StartupTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $StartupTaskName -TaskPath $StartupTaskPath -Confirm:$false | Out-Null
    }

    return [pscustomobject]@{
        task_name = $StartupTaskName
        removed = [bool]$existing
    } | ConvertTo-Json -Depth 6
}

function Show-StartupTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop

    $task = Get-ScheduledTask -TaskName $StartupTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{
            task_name = $StartupTaskName
            task_path = $StartupTaskPath
            exists = $false
        } | ConvertTo-Json -Depth 6
    }

    $info = Get-ScheduledTaskInfo -TaskName $StartupTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    $action = $task.Actions | Select-Object -First 1
    $trigger = $task.Triggers | Select-Object -First 1

    return [pscustomobject]@{
        task_name = $StartupTaskName
        task_path = $StartupTaskPath
        exists = $true
        state = [string]$task.State
        last_run_time = if ($info) { $info.LastRunTime } else { $null }
        next_run_time = if ($info) { $info.NextRunTime } else { $null }
        last_task_result = if ($info) { $info.LastTaskResult } else { $null }
        author = $task.RegistrationInfo.Author
        description = $task.RegistrationInfo.Description
        principal = [pscustomobject]@{
            user_id = $task.Principal.UserId
            logon_type = [string]$task.Principal.LogonType
            run_level = [string]$task.Principal.RunLevel
        }
        action = if ($action) {
            [pscustomobject]@{
                execute = $action.Execute
                arguments = $action.Arguments
                working_directory = $action.WorkingDirectory
            }
        } else {
            $null
        }
        trigger = if ($trigger) {
            [pscustomobject]@{
                enabled = $trigger.Enabled
                start_boundary = $trigger.StartBoundary
                user_id = $trigger.UserId
            }
        } else {
            $null
        }
    } | ConvertTo-Json -Depth 6
}

function Create-Shortcuts {
    Ensure-Directories
    $definitions = Get-ShortcutDefinitions
    $created = foreach ($definition in $definitions) {
        New-ConsoleShortcut -Definition $definition
    }

    return [pscustomobject]@{
        shortcut_root = $ShortcutRoot
        shortcuts = $created
    } | ConvertTo-Json -Depth 6
}

function Remove-Shortcuts {
    $definitions = Get-ShortcutDefinitions
    $removed = @()
    foreach ($definition in $definitions) {
        if (Test-Path -LiteralPath $definition.Path) {
            Remove-Item -LiteralPath $definition.Path -Force
            $removed += $definition.Path
        }
    }

    if (Test-Path -LiteralPath $ShortcutRoot) {
        $remaining = Get-ChildItem -LiteralPath $ShortcutRoot -Force -ErrorAction SilentlyContinue
        if (-not $remaining) {
            Remove-Item -LiteralPath $ShortcutRoot -Force -ErrorAction SilentlyContinue
        }
    }

    return [pscustomobject]@{
        shortcut_root = $ShortcutRoot
        removed = $removed
    } | ConvertTo-Json -Depth 6
}

function Get-ShortcutDefinitions {
    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    $baseArgs = {
        param([string]$CommandName)
        return "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" $CommandName"
    }

    return @(
        [pscustomobject]@{
            Name = 'Start Console MCP Server'
            Path = Join-Path $ShortcutRoot 'Start Console MCP Server.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'start-server'
            WorkingDirectory = $Root
        }
        [pscustomobject]@{
            Name = 'Stop Console MCP Server'
            Path = Join-Path $ShortcutRoot 'Stop Console MCP Server.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'stop-server'
            WorkingDirectory = $Root
        }
        [pscustomobject]@{
            Name = 'Status ChatGPT MCP'
            Path = Join-Path $ShortcutRoot 'Status ChatGPT MCP.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'status'
            WorkingDirectory = $Root
        }
        [pscustomobject]@{
            Name = 'Tail Logs'
            Path = Join-Path $ShortcutRoot 'Tail Logs.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'tail-server-log'
            WorkingDirectory = $Root
        }
    )
}

function New-ConsoleShortcut {
    param([Parameter(Mandatory = $true)]$Definition)

    Ensure-Directories
    New-Item -ItemType Directory -Force -Path $ShortcutRoot | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Definition.Path)
    $shortcut.TargetPath = $Definition.Target
    $shortcut.Arguments = $Definition.Arguments
    $shortcut.WorkingDirectory = $Definition.WorkingDirectory
    $shortcut.Description = $Definition.Name
    $shortcut.Save()

    return $Definition.Path
}

function Show-Status {
    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $bearerSecret = Get-ConsoleBearerTokenStatus
    $localChatgptSmoke = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $localCodexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
    $publicSmoke = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet

    [pscustomobject]@{
        chatgpt_oauth = $chatgptState
        codex_bearer = $codexState
        codex_bearer_secret = $bearerSecret
        tunnel = $tunnelState
        build_output = Get-BuildOutputReport
        tailscale = Get-TailscaleReport
        autostart = Get-AutostartSummary
        chatgpt_connector_refresh = Get-ChatgptConnectorRefreshState
        restart = Get-RestartState
        smoke = [pscustomobject]@{
            local_chatgpt = $localChatgptSmoke
            local_codex = $localCodexSmoke
            public = $publicSmoke
        }
    } | ConvertTo-Json -Depth 10
}

function Start-UnifiedConsoleRuntime {
    Ensure-BuildOutput | Out-Null
    $tokenResolution = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN' -WithSource
    $token = [string]$tokenResolution.value
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "CONSOLE_MCP_BEARER_TOKEN must be set before starting the unified console-mcp runtime."
    }

    $spec = Get-ChatgptSpec
    $spec.Name = 'unified-runtime'
    $spec.Environment['CONSOLE_MCP_AUTH_MODE'] = ''
    $spec.Environment['CONSOLE_MCP_MANAGED_RUNTIME'] = 'watchdog-session-relay'
    $spec.LogFile = Join-Path $LogDir 'console-mcp-unified.log'
    $spec.RequiresBearerToken = $true
    $spec.Environment['CONSOLE_MCP_BEARER_TOKEN'] = $token.Trim()
    $spec.Environment['CONSOLE_MCP_BEARER_TOKEN_SOURCE'] = [string]$tokenResolution.source

    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $sharedPid = $chatgptState.pid -and $codexState.pid -and ([int]$chatgptState.pid -eq [int]$codexState.pid)
    $runtimeCurrent = $chatgptState.runtime_state -eq 'current' -and $codexState.runtime_state -eq 'current'
    if ($chatgptState.running -and $chatgptState.port_open -and $codexState.running -and $codexState.port_open -and $sharedPid -and $runtimeCurrent) {
        return ($chatgptState | ConvertTo-Json -Depth 10)
    }
    if ($chatgptState.running -or $codexState.running -or $chatgptState.port_open -or $codexState.port_open) {
        Stop-UnifiedConsoleRuntime | Out-Null
    }

    # $spec is cloned from Get-ChatgptSpec, so $spec.Port is always 3333 - Start-ManagedProcess's
    # own Wait-ForPortOpen only ever confirms the ChatGPT/OAuth port. That let this function return
    # "ready" while the Codex/Bearer port (3334) had not opened yet at all - the real single
    # process serves both, so readiness has to mean both, not whichever port the cloned spec
    # happens to carry. Explicitly wait on the Codex port too before declaring the runtime started.
    Start-ManagedProcess -Spec $spec -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', (Join-Path $Root 'dist/index.js')) | Out-Null
    Wait-ForPortOpen -Port (Get-CodexSpec).Port -TimeoutSeconds 30
    return (Get-ManagedProcessState -Spec (Get-ChatgptSpec) | ConvertTo-Json -Depth 10)
}

function Stop-UnifiedConsoleRuntime {
    Stop-ManagedProcess -Spec (Get-ChatgptSpec)
}

function Start-ChatgptOauth {
    Start-UnifiedConsoleRuntime
}

function Stop-ChatgptOauth {
    Stop-UnifiedConsoleRuntime
}

function Start-CodexBearer {
    Start-UnifiedConsoleRuntime
}

function Stop-CodexBearer {
    Stop-UnifiedConsoleRuntime
}

function Start-Tunnel {
    Ensure-Directories
    if (-not (Test-Path -LiteralPath $CloudflaredConfig)) {
        throw "cloudflared config not found at $CloudflaredConfig."
    }

    Check-Cloudflared -FailOnMissing | Out-Null

    $spec = Get-TunnelSpec
    $cloudflared = Resolve-CloudflaredExe
    $result = Start-ManagedProcess -Spec $spec -FilePath $cloudflared -Arguments @('tunnel', '--config', $CloudflaredConfig, 'run', 'console-mcp')
    Wait-PublicSmokeReady | Out-Null
    return $result
}

function Stop-Tunnel {
    Stop-ManagedProcess -Spec (Get-TunnelSpec)
}

function Stop-ServerForWatchdogRecovery {
    # See tool/dev-console.d/90-server-lifecycle.ps1 for the authoritative process discovery,
    # confirmed-kill, and post-stop verification this delegates to. Unlike the previous
    # fire-and-forget implementation, this can no longer report success while an old server PID is
    # still alive: Invoke-ConsoleServerConfirmedStop only returns ok=$true once the old PIDs are
    # confirmed dead, their ports are released, the watchdog has been resumed exactly once, and a
    # replacement process with a different PID is healthy on both endpoints.
    $result = Invoke-ConsoleServerConfirmedStop
    $json = $result | ConvertTo-Json -Depth 30
    Write-Output $json
    if (-not $result.ok) {
        exit 1
    }
}

function Get-ChatgptConnectorRefreshState {
    if (-not (Test-Path -LiteralPath $ConnectorRefreshStateFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            status = 'never-run'
            state_file = $ConnectorRefreshStateFile
        }
    }

    try {
        return (Get-Content -LiteralPath $ConnectorRefreshStateFile -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'state-file-unreadable'
            state_file = $ConnectorRefreshStateFile
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Resolve-PendingChatgptConnectorRefresh {
    $state = Get-ChatgptConnectorRefreshState
    if (-not $state -or $state.status -ne 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING') {
        return $state
    }
    if (-not $state.schema_propagation -or $state.schema_propagation.ui_confirmed -ne $true) {
        return $state
    }
    if (-not (Test-Path -LiteralPath $ChatgptSchemaAuditFile -PathType Leaf)) {
        return $state
    }

    try {
        $audit = Get-Content -LiteralPath $ChatgptSchemaAuditFile -Raw | ConvertFrom-Json
        $baseline = $state.schema_propagation.baseline_audit
        $candidateSequence = $null
        $baselineSequence = $null
        $candidateObservedAtUnixMs = $null
        $baselineObservedAtUnixMs = $null
        try { $candidateSequence = [int64]$audit.sequence } catch { $candidateSequence = $null }
        try { $baselineSequence = [int64]$baseline.sequence } catch { $baselineSequence = $null }
        try { $candidateObservedAtUnixMs = [int64]$audit.observed_at_unix_ms } catch { $candidateObservedAtUnixMs = $null }
        try { $baselineObservedAtUnixMs = [int64]$baseline.observed_at_unix_ms } catch { $baselineObservedAtUnixMs = $null }

        $isNewAudit = $false
        $observationReason = $null
        if ($null -ne $candidateSequence -and $null -ne $baselineSequence) {
            $isNewAudit = $candidateSequence -gt $baselineSequence
            if ($isNewAudit) { $observationReason = 'sequence_advanced_after_pending' }
        } elseif ($null -ne $candidateObservedAtUnixMs -and $null -ne $baselineObservedAtUnixMs) {
            $isNewAudit = $candidateObservedAtUnixMs -gt $baselineObservedAtUnixMs
            if ($isNewAudit) { $observationReason = 'observed_at_unix_ms_advanced_after_pending' }
        } else {
            $stateAt = [datetime]::Parse([string]$state.at)
            $auditAt = [datetime]::Parse([string]$audit.timestamp)
            $isNewAudit = $auditAt.ToUniversalTime() -ge $stateAt.ToUniversalTime().AddSeconds(-1)
            if ($isNewAudit) { $observationReason = 'audit_timestamp_after_pending' }
        }

        if (-not $isNewAudit) {
            return $state
        }

        $expectedFingerprint = [string]$state.schema_propagation.expected_schema_fingerprint
        $observedFingerprint = [string]$audit.schema_fingerprint
        $matches = -not [string]::IsNullOrWhiteSpace($expectedFingerprint) -and $observedFingerprint -eq $expectedFingerprint

        $state.schema_propagation.tools_list_observed_after_refresh = $true
        $state.schema_propagation.pending = $false
        $state.schema_propagation.audit_observation_reason = $observationReason
        $state.schema_propagation.observed_schema_fingerprint = $observedFingerprint
        $state.schema_propagation.schema_fingerprint_match = [bool]$matches
        $state.schema_propagation.audit = $audit
        $state.schema_propagation.ok = [bool]$matches
        $state.schema_propagation.status = if ($matches) { 'CONNECTOR_SCHEMA_PROPAGATION_CONFIRMED' } else { 'CHATGPT_SCHEMA_FINGERPRINT_MISMATCH' }
        $state.ok = [bool]$matches
        $state.status = [string]$state.schema_propagation.status
        $state.resolved_from_pending = $true
        $state.resolved_at = (Get-Date).ToString('o')
        $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        return $state
    } catch {
        return $state
    }
}

function Test-ChatgptConnectorRefreshAcceptable {
    param([object]$Result)
    if (-not $Result) { return $false }
    return [bool]($Result.ok -eq $true -or $Result.status -eq 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING')
}

function Get-RuntimeToolSurfaceReport {
    $expectedTools = Get-DefaultExpectedSurface
    try {
        $codexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        $runtimeTools = @()
        if ($codexSmoke.authenticated_smoke -and $codexSmoke.authenticated_smoke.PSObject.Properties.Name -contains 'list_tools') {
            $runtimeTools = @($codexSmoke.authenticated_smoke.list_tools | Sort-Object -Unique)
        }
        $healthPayload = $null
        try { $healthPayload = $codexSmoke.authenticated_smoke.health.structuredContent } catch { $healthPayload = $null }
        $chatgptSchemaFingerprint = $null
        $buildFingerprint = $null
        $canonicalRegistryFingerprint = $null
        try { $chatgptSchemaFingerprint = [string]$healthPayload.consumers.chatgpt.schemaFingerprint } catch { $chatgptSchemaFingerprint = $null }
        try { $buildFingerprint = [string]$healthPayload.buildFingerprint } catch { $buildFingerprint = $null }
        try { $canonicalRegistryFingerprint = [string]$healthPayload.canonicalRegistryFingerprint } catch { $canonicalRegistryFingerprint = $null }
        return [pscustomobject]@{
            ok = $codexSmoke.ok -eq $true
            runtime_schema = [pscustomobject]@{
                source = 'authenticated MCP tool list + health runtime fingerprint'
                count = $runtimeTools.Count
                tools = $runtimeTools
                smoke_ok = $codexSmoke.ok
                chatgpt_schema_fingerprint = $chatgptSchemaFingerprint
                build_fingerprint = $buildFingerprint
                canonical_registry_fingerprint = $canonicalRegistryFingerprint
            }
            comparison = Compare-ToolSurface -ExpectedTools $expectedTools -RuntimeTools $runtimeTools
            smoke = $codexSmoke
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            runtime_schema = [pscustomobject]@{ source = 'authenticated MCP tool list + health runtime fingerprint'; count = 0; tools = @(); smoke_ok = $false; chatgpt_schema_fingerprint = $null; build_fingerprint = $null; canonical_registry_fingerprint = $null }
            comparison = [pscustomobject]@{ ok = $false; status = 'RUNTIME_TOOLS_UNAVAILABLE'; expected_count = $expectedTools.Count; runtime_count = 0; missing_count = $null; unexpected_count = $null; missing = @(); unexpected = @(); error = Sanitize-Text $_.Exception.Message }
        }
    }
}

# Connector refresh is owned by tool/dev-console.d/60-connector-refresh.ps1.
function Invoke-ChatgptSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$Quiet
    )

    $metadata = Invoke-HttpProbe -Url "$Origin/.well-known/oauth-protected-resource"
    $mcp = Invoke-HttpProbe -Url "$Origin/mcp"
    $summary = [pscustomobject]@{
        label = $Label
        origin = $Origin
        metadata_status = $metadata.status_code
        metadata_content_type = $metadata.content_type
        metadata_www_authenticate = $metadata.www_authenticate
        mcp_status = $mcp.status_code
        mcp_www_authenticate = $mcp.www_authenticate
        metadata_ok = $metadata.status_code -eq 200 -and $metadata.content_type -match 'application/json'
        mcp_unauthorized = $mcp.status_code -eq 401 -and -not [string]::IsNullOrWhiteSpace($mcp.www_authenticate)
        ok = $metadata.status_code -eq 200 -and $metadata.content_type -match 'application/json' -and $mcp.status_code -eq 401 -and -not [string]::IsNullOrWhiteSpace($mcp.www_authenticate)
        metadata_error = $metadata.error
        mcp_error = $mcp.error
    }

    return $summary
}

function Invoke-CodexSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$Quiet
    )

    $missing = Invoke-HttpProbe -Url "$Origin/mcp"
    $wrong = Invoke-HttpProbe -Url "$Origin/mcp" -Headers @{ Authorization = 'Bearer definitely-wrong-token' }

    $authenticatedSmoke = [pscustomobject]@{
        skipped = $true
        reason = 'codex bearer token not set; authenticated smoke skipped'
    }

    $token = $null
    try {
        $token = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN'
    } catch {
        $authenticatedSmoke = [pscustomobject]@{
            skipped = $true
            reason = 'codex bearer token unavailable; authenticated smoke skipped'
            diagnostic = Sanitize-Text $_.Exception.Message
        }
    }
    if ($token) {
        try {
            $authenticatedSmoke = Invoke-NodeMcpSmoke -Origin $Origin -WorkspacePath $Root -BearerToken $token
            if ($authenticatedSmoke.status_code -eq 401 -and $authenticatedSmoke.stage -eq 'AUTH') {
                $diagnostic = 'codex bearer authenticated smoke failed: token mismatch or stale bearer server; run restart-codex-bearer after setting CONSOLE_MCP_BEARER_TOKEN'
                $authenticatedSmoke = [pscustomobject]@{
                    ok = $false
                    stage = 'AUTH'
                    status_code = 401
                    error = $diagnostic
                    diagnostic = $diagnostic
                }
            }
        } catch {
            $authenticatedSmoke = [pscustomobject]@{
                ok = $false
                stage = 'CODEX_RUNTIME'
                error = Sanitize-Text $_.Exception.Message
            }
        }
    }

    $summary = [pscustomobject]@{
        label = $Label
        origin = $Origin
        missing_token_status = $missing.status_code
        missing_token_www_authenticate = $missing.www_authenticate
        missing_token_expected_401 = $missing.status_code -eq 401
        wrong_token_status = $wrong.status_code
        wrong_token_www_authenticate = $wrong.www_authenticate
        wrong_token_expected_401 = $wrong.status_code -eq 401
        authenticated_smoke = $authenticatedSmoke
        authenticated_smoke_skipped = [bool]$authenticatedSmoke.skipped
        # NOTE: a skipped authenticated smoke (bearer token could not be resolved - e.g. AWS creds
        # unavailable in this execution context) used to count as "ok" here, as long as the two
        # unauthenticated-401 checks passed. That let this report HEALTHY while the actual
        # authenticated MCP protocol (tool listing, JSON-RPC) was never verified at all - exactly
        # the kind of silent degradation that makes a watchdog's "healthy" verdict untrustworthy.
        # A skip is now a failure for the purposes of `ok`, surfaced distinctly via degraded below.
        degraded = [bool]$authenticatedSmoke.skipped
        ok = $missing.status_code -eq 401 -and $wrong.status_code -eq 401 -and $authenticatedSmoke.ok -eq $true
    }

    return $summary
}

function Tail-File {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Output "File not found: $Path"
        return
    }

    Get-Content -LiteralPath $Path -Tail 100 -Wait
}

function Get-ManagedPid {
    param([Parameter(Mandatory = $true)][string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile)) {
        return $null
    }

    $text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $parsed = 0
    if (-not [int]::TryParse($text, [ref]$parsed)) {
        return $null
    }

    return $parsed
}

function Test-ManagedPid {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    try {
        Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-ListeningProcessOnPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
        Select-Object -First 1

    return $connection
}

function Get-ManagedProcessByMatcher {
    param([Parameter(Mandatory = $true)][string]$Matcher)

    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $Matcher } |
        Select-Object -First 1
}

function Wait-ForPortOpen {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSeconds = 30
    )

    $attempts = [Math]::Ceiling($TimeoutSeconds * 10)
    for ($i = 0; $i -lt $attempts; $i++) {
        if (Get-ListeningProcessOnPort -Port $Port) {
            return
        }

        Start-Sleep -Milliseconds 100
    }

    throw "Port $Port did not become ready within $TimeoutSeconds seconds."
}

function Invoke-ProcessKill {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-TreeKill {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $taskkill = Get-Command taskkill.exe -ErrorAction Stop
    & $taskkill.Source /PID $ProcessId /T /F | Out-Null
}

function Invoke-LogRotationIfNeeded {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$MaxBytes = 20MB,
        [int]$Keep = 3
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item -or $item.Length -lt $MaxBytes) {
        return
    }

    $oldest = "$Path.$Keep"
    if (Test-Path -LiteralPath $oldest) {
        Remove-Item -LiteralPath $oldest -Force -ErrorAction SilentlyContinue
    }

    for ($i = $Keep - 1; $i -ge 1; $i--) {
        $src = "$Path.$i"
        if (Test-Path -LiteralPath $src) {
            Move-Item -LiteralPath $src -Destination "$Path.$($i + 1)" -Force -ErrorAction SilentlyContinue
        }
    }

    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force -ErrorAction SilentlyContinue
}

function Write-SafeLogLine {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $sanitized = Sanitize-Text $Text
    [System.Threading.Monitor]::Enter($LogLock)
    try {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
        # var/log/console-mcp-watchdog-loop.log grew unbounded to 54MB+ over a week with no
        # rotation, because heartbeats append forever. Keep it bounded: 20MB per file, 3 rotated
        # backups (.1/.2/.3), same policy for every log file that goes through this function.
        Invoke-LogRotationIfNeeded -Path $Path
        [System.IO.File]::AppendAllText($Path, ($sanitized + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    } finally {
        [System.Threading.Monitor]::Exit($LogLock)
    }
}

function Escape-CmdArgument {
    param([Parameter(Mandatory = $true)][string]$Argument)

    $value = [string]$Argument
    $value = $value -replace '"', '\"'
    if ($value -match '[\s"&<>|]') {
        return '"' + $value + '"'
    }

    return $value
}

function Sanitize-Text {
    param([Parameter(Mandatory = $true)][string]$Text)

    $value = $Text
    $value = $value -replace '(?i)(Authorization:\s*Bearer\s+)[^\s"]+', '$1[redacted]'
    $value = $value -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+\b', 'Bearer [redacted]'
    $value = $value -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+', '[redacted-jwt]'
    $value = $value -replace '(?i)\b(client_secret|authorization_code|refresh_token|access_token|token|code)\b\s*[:=]\s*[^,\s"]+', '$1=[redacted]'
    $value = $value -replace '(?i)([?&](?:token|code|refresh_token|client_secret|access_token)=[^&\s]+)', '[redacted]'
    return $value
}

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














