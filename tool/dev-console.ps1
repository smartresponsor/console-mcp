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
        'start-chatgpt-oauth',
        'stop-chatgpt-oauth',
        'start-codex-bearer',
        'stop-codex-bearer',
        'runtime-replace-plan',
        'runtime-replace-stale',
        'stop-server',
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
$DesktopAgentStateFile = Join-Path $RunDir 'desktop-agent.state.json'
$DesktopAgentLoopPidFile = Join-Path $RunDir 'desktop-agent-heartbeat-loop.pid'
$DesktopAgentLoopLogFile = Join-Path $LogDir 'desktop-agent-heartbeat-loop.log'
$DesktopAgentTaskName = 'console-mcp-desktop-agent-heartbeat'
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
    'runtime-replace-plan',
    'runtime-replace-stale',
    'start-codex-bearer',
    'restart-codex-bearer',
    'restart-codex-bearer-soft',
    'restart-codex-bearer-warm',
    'restart-codex-bearer-cold',
    'restart-all-plan',
    'restart-all',
    'restart-all-soft',
    'restart-all-warm',
    'restart-all-cold',
    'watchdog-heal',
    'watchdog-loop-run',
    'start-watchdog-loop',
    'restart-watchdog-loop',
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
        $Issues.Add(("{0}:{1}" -f $Name, $(if ($status) { [string]$status } else { 'not-ok' }))) | Out-Null
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
        throw ("Auth runtime postcondition failed. kind={0}; status={1}; process_running={2}; port_open={3}; local_ok={4}; freshness_ok={5}; public_ok={6}" -f $Kind, $postcondition.status, $postcondition.process.running, $postcondition.process.port_open, $postcondition.local.ok, $postcondition.freshness.ok, $(if ($postcondition.public) { $postcondition.public.ok } else { $null }))
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

        if ($lockIsFresh -and $lockProcess -and -not $lockIsSelfOwned) {
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
function Invoke-VarRetentionIfDue {
    param([int]$IntervalHours = 6)

    $due = $true
    if (Test-Path -LiteralPath $RetentionMarkerFile) {
        try {
            $marker = Get-Content -LiteralPath $RetentionMarkerFile -Raw | ConvertFrom-Json
            $lastRun = [datetime]::Parse([string]$marker.at)
            if (((Get-Date).ToUniversalTime() - $lastRun.ToUniversalTime()).TotalHours -lt $IntervalHours) {
                $due = $false
            }
        } catch {
            $due = $true
        }
    }

    if (-not $due) {
        return $null
    }

    $results = foreach ($target in $RetentionTargets) {
        $targetPath = $target.Path
        $maxAgeDays = $target.MaxAgeDays
        $deleted = 0
        $kept = 0
        $bytesFreed = [int64]0
        if (Test-Path -LiteralPath $targetPath -PathType Container) {
            $cutoffUtc = (Get-Date).ToUniversalTime().AddDays(-1 * $maxAgeDays)
            Get-ChildItem -LiteralPath $targetPath -File -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.LastWriteTimeUtc -lt $cutoffUtc) {
                    $bytesFreed += $_.Length
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                    $deleted++
                } else {
                    $kept++
                }
            }
        }
        [pscustomobject]@{ path = $targetPath; max_age_days = $maxAgeDays; deleted = $deleted; kept = $kept; bytes_freed = $bytesFreed }
    }

    $summary = [pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('o'); results = @($results) }
    $summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $RetentionMarkerFile -Encoding utf8
    return $summary
}

function Invoke-MobileEdgeHealthProbe {
    if (-not (Test-Path -LiteralPath $MobileEdgeWorkspacePath -PathType Container)) {
        return [pscustomobject]@{ ok = $false; status = 'MOBILE_EDGE_WORKSPACE_MISSING'; url = $MobileEdgeHealthUrl; workspace = $MobileEdgeWorkspacePath; error = 'Mobiling mobile-edge workspace was not found.' }
    }

    try {
        $response = Invoke-WebRequest -Uri $MobileEdgeHealthUrl -Method Get -TimeoutSec 3 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{ ok = [bool]($response.StatusCode -ge 200 -and $response.StatusCode -lt 400); status = if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { 'MOBILE_EDGE_HEALTHY' } else { 'MOBILE_EDGE_UNHEALTHY_STATUS' }; url = $MobileEdgeHealthUrl; status_code = [int]$response.StatusCode; body = Sanitize-Text ([string]$response.Content); workspace = $MobileEdgeWorkspacePath; error = $null }
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'MOBILE_EDGE_UNREACHABLE'; url = $MobileEdgeHealthUrl; status_code = $null; body = ''; workspace = $MobileEdgeWorkspacePath; error = Sanitize-Text $_.Exception.Message }
    }
}

function Stop-MobileEdgePortProcess {
    $stopped = @()
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $MobileEdgePort -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
        $pid = [int]$connection.OwningProcess
        if ($pid -le 0) { continue }
        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            $stopped += [pscustomobject]@{ pid = $pid; stopped = $true }
        } catch {
            $stopped += [pscustomobject]@{ pid = $pid; stopped = $false; error = Sanitize-Text $_.Exception.Message }
        }
    }
    return @($stopped)
}

function Start-MobileEdgeDevServer {
    if (-not (Test-Path -LiteralPath $MobileEdgeWorkspacePath -PathType Container)) {
        throw "Mobiling mobile-edge workspace was not found at $MobileEdgeWorkspacePath"
    }

    New-Item -ItemType Directory -Force -Path $MobileEdgeLogDir | Out-Null
    $npm = Get-NpmCommand
    $pwsh = Get-PwshCommand
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $stdoutLog = Join-Path $MobileEdgeLogDir "$stamp-stdout.log"
    $stderrLog = Join-Path $MobileEdgeLogDir "$stamp-stderr.log"
    $command = '$env:PORT="' + $MobileEdgePort + '"; & "' + $npm + '" run dev'
    $process = Start-Process -FilePath $pwsh.Source -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -WorkingDirectory $MobileEdgeWorkspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    return [pscustomobject]@{ pid = $process.Id; workspace = $MobileEdgeWorkspacePath; port = $MobileEdgePort; stdout_log = $stdoutLog; stderr_log = $stderrLog; command = 'npm run dev' }
}

function Invoke-MobileEdgeWatchdogHeal {
    $before = Invoke-MobileEdgeHealthProbe
    if ($before.ok -eq $true) {
        return [pscustomobject]@{ ok = $true; status = 'MOBILE_EDGE_HEALTHY'; action_taken = 'none'; before = $before; after = $before; start = $null; stopped = @() }
    }

    $stopped = Stop-MobileEdgePortProcess
    $start = Start-MobileEdgeDevServer
    $after = $null
    foreach ($attempt in 1..30) {
        Start-Sleep -Milliseconds 500
        $after = Invoke-MobileEdgeHealthProbe
        if ($after.ok -eq $true) { break }
    }

    return [pscustomobject]@{ ok = [bool]($after -and $after.ok -eq $true); status = if ($after -and $after.ok -eq $true) { 'MOBILE_EDGE_HEALED' } else { 'MOBILE_EDGE_FAILED' }; action_taken = 'restart'; before = $before; stopped = @($stopped); start = $start; after = $after }
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
            Start-ChatgptOauth | Out-Null
            Wait-ManagedServiceReady -Spec (Get-ChatgptSpec) -Origin $ChatgptOrigin -Kind 'chatgpt' | Out-Null
        }

        $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $localCodex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        if (-not $codexState.running -or -not $codexState.port_open -or $localCodex.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'start-codex-bearer'; reason = 'local codex bearer was not ready' }
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
            $actions += [pscustomobject]@{ action = 'connector-schema-propagation-observation'; reason = 'legacy refresh is deprecated and non-blocking'; refresh_status = $connectorRefresh.status; refresh_ok = $connectorRefresh.ok }
        }
        $codexOk = [bool]($finalCodexState.running -and $finalCodexState.port_open -and $finalLocalCodex.ok -eq $true)
        # Server recovery (chatgpt/codex/tunnel/public/mobile-edge) is the required, SSH-safe half of
        # watchdog health. Browser-visible recovery is best-effort: when it fails solely because this
        # process is outside the interactive desktop session (SSH/session-0), that is an expected,
        # non-actionable limitation, not a stack failure, so it must not flip the overall status to FAILED.
        $serverOk = [bool]($finalChatgptState.running -and $finalChatgptState.port_open -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $codexOk -and $finalTunnelState.running -and $finalPublic.ok -eq $true -and $mobileEdge.ok -eq $true)
        $ok = [bool]($serverOk -and ($browserOk -or $browserSessionBlocked))
        $status = if ($ok -and $browserOk -and $actions.Count -gt 0) { 'HEALED' } elseif ($ok -and $browserOk) { 'HEALTHY' } elseif ($ok -and $browserSessionBlocked) { 'DEGRADED_BROWSER_RECOVERY_UNAVAILABLE' } elseif ($mobileEdge.ok -ne $true) { 'FAILED_MOBILE_EDGE_NOT_READY' } elseif ($finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -ne $true) { 'FAILED_STALE_RUNTIME_NOT_REPLACED' } else { 'FAILED' }
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

function Install-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop

    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    $action = New-ScheduledTaskAction -Execute $pwsh.Source -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" start-watchdog-loop" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $description = 'Repair-only watchdog for console-mcp ChatGPT OAuth and cloudflared public availability.'

    Register-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
    return Show-WatchdogTask
}

function Uninstall-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop
    $existing = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -Confirm:$false | Out-Null
    }
    return [pscustomobject]@{ task_name = $WatchdogTaskName; removed = [bool]$existing } | ConvertTo-Json -Depth 6
}

function Show-WatchdogTask {
    Ensure-Directories
    Import-Module ScheduledTasks -ErrorAction Stop
    $task = Get-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{ task_name = $WatchdogTaskName; task_path = $StartupTaskPath; exists = $false; state = Get-WatchdogState } | ConvertTo-Json -Depth 8
    }
    $info = Get-ScheduledTaskInfo -TaskName $WatchdogTaskName -TaskPath $StartupTaskPath -ErrorAction SilentlyContinue
    $action = $task.Actions | Select-Object -First 1
    $trigger = $task.Triggers | Select-Object -First 1
    return [pscustomobject]@{
        task_name = $WatchdogTaskName
        task_path = $StartupTaskPath
        exists = $true
        task_state = [string]$task.State
        last_run_time = if ($info) { $info.LastRunTime } else { $null }
        next_run_time = if ($info) { $info.NextRunTime } else { $null }
        last_task_result = if ($info) { $info.LastTaskResult } else { $null }
        action = if ($action) { [pscustomobject]@{ execute = $action.Execute; arguments = $action.Arguments; working_directory = $action.WorkingDirectory } } else { $null }
        trigger = if ($trigger) { [pscustomobject]@{ enabled = $trigger.Enabled; start_boundary = $trigger.StartBoundary; repetition_interval = $trigger.Repetition.Interval; repetition_duration = $trigger.Repetition.Duration } } else { $null }
        state = Get-WatchdogStateStatus
    } | ConvertTo-Json -Depth 12
}

function Get-WatchdogLoopIntervalSeconds {
    $configured = $env:CONSOLE_MCP_WATCHDOG_LOOP_INTERVAL_SECONDS
    $parsed = 0
    if ($configured -and [int]::TryParse($configured, [ref]$parsed) -and $parsed -ge 2 -and $parsed -le 60) {
        return $parsed
    }
    return 5
}

function Write-WatchdogLoopState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )

    Ensure-Directories
    $state = [ordered]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        pid = $PID
        pid_file = $WatchdogLoopPidFile
        state_file = $WatchdogLoopStateFile
        log_file = $WatchdogLoopLogFile
        interval_seconds = Get-WatchdogLoopIntervalSeconds
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $json = ($state | ConvertTo-Json -Depth 30)
    $json | Set-Content -LiteralPath $WatchdogLoopStateFile -Encoding utf8
    Write-SafeLogLine -Path $WatchdogLoopLogFile -Text ($json -replace "`r?`n", ' ')
    return [pscustomobject]$state
}

function Get-WatchdogLoopProcessState {
    $loopPid = Get-ManagedPid -PidFile $WatchdogLoopPidFile
    $alive = $loopPid -and (Test-ManagedPid -ProcessId $loopPid)
    $process = if ($alive) { Get-CimInstance Win32_Process -Filter "ProcessId = $loopPid" -ErrorAction SilentlyContinue } else { $null }
    $state = if (Test-Path -LiteralPath $WatchdogLoopStateFile -PathType Leaf) {
        try { Get-Content -LiteralPath $WatchdogLoopStateFile -Raw | ConvertFrom-Json } catch { $null }
    } else { $null }

    return [pscustomobject]@{
        name = 'console-mcp-watchdog-loop'
        pid_file = $WatchdogLoopPidFile
        pid = if ($alive) { $loopPid } else { $null }
        running = [bool]$alive
        stale_pid_file = [bool]($loopPid -and -not $alive)
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        state_file = $WatchdogLoopStateFile
        log_file = $WatchdogLoopLogFile
        state = $state
    }
}

function Start-WatchdogLoop {
    Ensure-Directories
    $state = Get-WatchdogLoopProcessState
    if ($state.running) {
        return ($state | ConvertTo-Json -Depth 20)
    }

    Remove-Item -LiteralPath $WatchdogLoopPidFile -Force -ErrorAction SilentlyContinue
    $pwsh = Get-PwshCommand
    $scriptPath = Join-Path $Root 'tool\dev-console.ps1'
    $process = Start-Process `
        -FilePath $pwsh.Source `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, 'watchdog-loop-run') `
        -WorkingDirectory $Root `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput ($WatchdogLoopLogFile + '.stdout.log') `
        -RedirectStandardError ($WatchdogLoopLogFile + '.stderr.log')

    Set-Content -LiteralPath $WatchdogLoopPidFile -Value $process.Id -NoNewline
    Start-Sleep -Milliseconds 750
    return (Get-WatchdogLoopProcessState | ConvertTo-Json -Depth 20)
}

function Stop-WatchdogLoop {
    $state = Get-WatchdogLoopProcessState
    $stopDetail = [ordered]@{
        requested_by = 'dev-console'
        pid = $state.pid
        running_before_stop = [bool]$state.running
        stop_attempted = $false
        stop_error = $null
    }

    if ($state.pid) {
        $stopDetail.stop_attempted = $true
        try {
            Stop-Process -Id ([int]$state.pid) -Force -ErrorAction Stop
        } catch {
            if (Test-ManagedPid -ProcessId ([int]$state.pid)) {
                $stopDetail.stop_error = Sanitize-Text $_.Exception.Message
            }
        }

        foreach ($attempt in 1..20) {
            if (-not (Test-ManagedPid -ProcessId ([int]$state.pid))) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }

    $stopDetail.running_after_stop = if ($state.pid) { Test-ManagedPid -ProcessId ([int]$state.pid) } else { $false }
    Remove-Item -LiteralPath $WatchdogLoopPidFile -Force -ErrorAction SilentlyContinue
    Write-WatchdogLoopState -Status 'STOPPED' -Ok (-not $stopDetail.running_after_stop) -Detail ([pscustomobject]$stopDetail) | Out-Null
    return (Get-WatchdogLoopProcessState | ConvertTo-Json -Depth 20)
}

function Restart-WatchdogLoop {
    Stop-WatchdogLoop | Out-Null
    return Start-WatchdogLoop
}

function Invoke-WatchdogLoopRun {
    Ensure-Directories
    Set-Content -LiteralPath $WatchdogLoopPidFile -Value $PID -NoNewline
    Write-WatchdogLoopState -Status 'STARTED' -Ok $true -Detail @{ mode = 'resident-loop' } | Out-Null

    while ($true) {
        try {
            $heal = Invoke-WatchdogHeal | ConvertFrom-Json
            # Log the full per-service snapshot (chatgpt_oauth/codex_bearer/local_codex/etc) on every
            # tick, not just when an action was taken. Previously only .status/.actions were kept,
            # so a tick that reported "healthy" left no trace of what running/port_open/smoke.ok
            # actually were at that moment - making it impossible to retroactively tell a genuine
            # health-check blind spot apart from a process that died in the gap between two ticks.
            Write-WatchdogLoopState -Status 'HEARTBEAT' -Ok ([bool]$heal.ok) -Detail @{ heal_status = $heal.status; heal_actions = $heal.actions; heal_detail = $heal.detail } | Out-Null
        } catch {
            Write-WatchdogLoopState -Status 'HEARTBEAT_FAILED' -Ok $false -ErrorMessage $_.Exception.Message | Out-Null
        }

        Start-Sleep -Seconds (Get-WatchdogLoopIntervalSeconds)
    }
}

function Save-ExpectedSurface {
    param([string[]]$ToolNames)

    Ensure-Directories
    $payload = [pscustomobject]@{
        generated_at = (Get-Date).ToString('o')
        tool_names = @($ToolNames | Sort-Object -Unique)
    }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ExpectedSurfaceFile -Encoding utf8
    return $payload
}

function Invoke-ColdRestartPreparation {
    $npm = Get-NpmCommand
    Push-Location $Root
    try {
        $output = & $npm install 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        $message = Sanitize-Text (($output | Out-String).Trim())
        throw "npm install failed during cold restart preparation. $message"
    }

    return [pscustomobject]@{ ok = $true; command = 'npm install' }
}

function Test-ExpectedToolsFromSmoke {
    param([object]$Smoke, [string[]]$ExpectedTools = @())

    $expected = @($ExpectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    if ($expected.Count -eq 0) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = 'no expected tools configured'; expected = @(); missing = @() }
    }

    $available = @()
    if ($Smoke -and $Smoke.PSObject.Properties.Name -contains 'list_tools') {
        $available = @($Smoke.list_tools)
    }

    $comparison = Compare-ToolSurface -ExpectedTools $expected -RuntimeTools $available
    $readinessOk = $comparison.missing_count -eq 0
    return [pscustomobject]@{
        ok = $readinessOk
        skipped = $false
        source = 'authenticated MCP tool list'
        readiness_status = if ($readinessOk) { 'EXPECTED_TOOLS_PRESENT' } else { 'EXPECTED_TOOLS_MISSING' }
        expected = $expected
        runtime = @($available | Sort-Object -Unique)
        comparison = $comparison
    }
}

function Wait-ManagedServiceReady {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [string[]]$ExpectedTools = @(),
        [int]$TimeoutSeconds = 45,
        [int]$IntervalMilliseconds = 500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $state = Get-ManagedProcessState -Spec $Spec
        if ($state.running -and $state.port_open) {
            if ($Kind -eq 'chatgpt') {
                $last = Invoke-ChatgptSmoke -Origin $Origin -Label 'local-chatgpt' -Quiet
                if ($last.ok -eq $true) {
                    return [pscustomobject]@{
                        ok = $true
                        process = $state
                        smoke = $last
                        expected_tools = [pscustomobject]@{ skipped = $true; reason = 'oauth profile readiness is transport-level; authenticated surface is checked through codex profile' }
                    }
                }
            } else {
                $last = Invoke-CodexSmoke -Origin $Origin -Label 'local-codex' -Quiet
                if ($last.ok -eq $true) {
                    $toolCheck = Test-ExpectedToolsFromSmoke -Smoke $last.authenticated_smoke -ExpectedTools $ExpectedTools
                    if ($toolCheck.ok -eq $true) {
                        return [pscustomobject]@{ ok = $true; process = $state; smoke = $last; expected_tools = $toolCheck }
                    }
                }
            }
        } else {
            $last = [pscustomobject]@{ ok = $false; reason = 'process-not-ready'; process = $state }
        }

        Start-Sleep -Milliseconds $IntervalMilliseconds
    }

    throw ("{0} did not become ready within {1} seconds. Last result: {2}" -f $Spec.Name, $TimeoutSeconds, (($last | ConvertTo-Json -Depth 20 -Compress)))
}

function Invoke-ManagedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode,
        [string[]]$ExpectedTools = @()
    )

    $spec = if ($Kind -eq 'chatgpt') { Get-ChatgptSpec } else { Get-CodexSpec }
    $origin = if ($Kind -eq 'chatgpt') { $ChatgptOrigin } else { $CodexOrigin }
    $start = if ($Kind -eq 'chatgpt') { { Start-ChatgptOauth | Out-Null } } else { { Start-CodexBearer | Out-Null } }
    $stop = if ($Kind -eq 'chatgpt') { { Stop-ChatgptOauth | Out-Null } } else { { Stop-CodexBearer | Out-Null } }

    if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }

    if ($Mode -in @('warm', 'cold')) {
        Ensure-BuildOutput | Out-Null
        & $stop
        & $start
    } else {
        $state = Get-ManagedProcessState -Spec $spec
        if (-not $state.running) { & $start }
    }

    return Wait-ManagedServiceReady -Spec $spec -Origin $origin -Kind $Kind -ExpectedTools $ExpectedTools
}

function Invoke-RestartAllSupervised {
    param([Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode)

    $preflight = Invoke-WatchdogPreflight -Purpose "restart-all-$Mode"
    Invoke-StackSnapshot -Purpose "restart-all-$Mode-before" | Out-Null
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'BUILDING' -Mode $Mode -Scope 'all' -Detail @{ expected_tools = $expectedTools } | Out-Null

    try {
        if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }
        if ($Mode -in @('warm', 'cold')) { Ensure-BuildOutput | Out-Null }

        Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICES' -Mode $Mode -Scope 'all' | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode $Mode -ExpectedTools @()
        $codex = Invoke-ManagedRestart -Kind 'codex' -Mode $Mode -ExpectedTools $expectedTools

        Write-RestartState -Generation $generation -Status 'REVERIFYING_LOCAL_CHATGPT' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex } | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'soft' -ExpectedTools @()
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt'

        Write-RestartState -Generation $generation -Status 'WAITING_PUBLIC_READY' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex; auth_runtime = $authRuntime } | Out-Null
        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            Start-Tunnel | Out-Null
        } elseif ($Mode -eq 'cold') {
            Stop-Tunnel | Out-Null
            Start-Tunnel | Out-Null
        }
        $public = Wait-PublicSmokeReady
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt' -RequirePublic

        Write-RestartState -Generation $generation -Status 'VERIFYING_BROWSER_POSTCONDITION' -Mode $Mode -Scope 'all' -Detail @{ public = $public; auth_runtime = $authRuntime } | Out-Null
        $browserPostcondition = Invoke-BrowserFreshPostcondition -Purpose "restart-all-$Mode"

        $refresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        $readyStatus = if ($browserPostcondition.ok -eq $true) { 'READY' } else { 'READY_BROWSER_NOT_READY' }

        $ready = [pscustomobject]@{ ok = $true; generation = $generation; mode = $Mode; status = $readyStatus; chatgpt = $chatgpt; codex = $codex; public = $public; browser = $browserPostcondition; connector_refresh = $refresh }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope 'all' -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        New-ServerLifecycleLaunchPrompt -Operation 'restart-all' -Generation $generation -Mode $Mode -Status $readyStatus -Detail $ready | Out-Null
        Invoke-StackSnapshot -Purpose "restart-all-$Mode-after-$readyStatus" | Out-Null
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope 'all' -ErrorMessage $message | Out-Null
        throw $message
    }
}

function Invoke-SingleServiceSupervisedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode
    )

    $preflight = $null
    if ($Kind -eq 'chatgpt') {
        $preflight = Invoke-WatchdogPreflight -Purpose "restart-$Kind-$Mode"
        Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-before" | Out-Null
    }
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICE' -Mode $Mode -Scope $Kind | Out-Null

    try {
        $result = Invoke-ManagedRestart -Kind $Kind -Mode $Mode -ExpectedTools $expectedTools
        $connectorRefresh = $null
        if ($Kind -eq 'chatgpt') {
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        }
        $readyStatus = 'READY'
        $ready = [pscustomobject]@{ ok = $true; generation = $generation; mode = $Mode; scope = $Kind; status = $readyStatus; service = $result; connector_refresh = $connectorRefresh; expected_tools = $expectedTools }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope $Kind -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        if ($Kind -eq 'chatgpt') {
            Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-after-$readyStatus" | Out-Null
        }
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope $Kind -ErrorMessage $message | Out-Null
        throw $message
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
        $state = Write-RuntimeReplaceState -Status $(if ($ok) { 'RUNTIME_REPLACE_READY' } else { 'RUNTIME_REPLACE_POSTCONDITION_FAILED' }) -Ok $ok -Plan $plan -Detail @{ restart = $result; postcondition = $postcondition }
        return ($state | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_FAILED' -Ok $false -Plan $plan -ErrorMessage $message
        return ($state | ConvertTo-Json -Depth 30)
    }
}

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
    $result = [ordered]@{
        ok = $false
        status = 'DESKTOP_RELOGIN_STARTED'
        at = (Get-Date).ToString('o')
        target_session_id = $sessionId
        before = $before
        autologon = $autologon
        after = $null
        browser = $null
        watchdog = $null
    }

    & logoff.exe $sessionId
    Start-Sleep -Seconds 8
    foreach ($attempt in 1..30) {
        $after = Get-ConsoleSessionReport
        if ($after.ok -and $after.active_console -and [int]$after.active_console.id -ne $sessionId) {
            $result.after = $after
            break
        }
        $result.after = $after
        Start-Sleep -Seconds 2
    }

    Start-Sleep -Seconds 8
    $browser = Get-BrowserStackHealthReport
    $result.browser = $browser
    $state = Write-ServerLaunchWatchdogState -Status 'DESKTOP_RELOGIN_CHECKED' -Detail ([pscustomobject]$result)
    $result.watchdog = $state
    $result.ok = [bool]($result.after.ok -and $browser.ok)
    $result.status = if ($result.ok) { 'DESKTOP_RELOGIN_READY' } else { 'DESKTOP_RELOGIN_NEEDS_ATTENTION' }
    return ([pscustomobject]$result | ConvertTo-Json -Depth 30)
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
    return [pscustomobject]@{
        phase = 'phase_3_post_login'
        autostart_summary = $summary
        compact_summary = Format-AutostartCompactSummary -Summary $summary
    } | ConvertTo-Json -Depth 12
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
            Name = 'Start ChatGPT MCP'
            Path = Join-Path $ShortcutRoot 'Start ChatGPT MCP.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'start-chatgpt-oauth'
            WorkingDirectory = $Root
        }
        [pscustomobject]@{
            Name = 'Restart ChatGPT MCP'
            Path = Join-Path $ShortcutRoot 'Restart ChatGPT MCP.lnk'
            Target = $pwsh.Source
            Arguments = & $baseArgs 'restart-chatgpt-oauth'
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
    $spec.LogFile = Join-Path $LogDir 'console-mcp-unified.log'
    $spec.RequiresBearerToken = $true
    $spec.Environment.CONSOLE_MCP_BEARER_TOKEN = $token.Trim()
    $spec.Environment.CONSOLE_MCP_BEARER_TOKEN_SOURCE = [string]$tokenResolution.source

    Start-ManagedProcess -Spec $spec -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', (Join-Path $Root 'dist/index.js'))
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

function Get-RuntimeToolSurfaceReport {
    $expectedTools = Get-DefaultExpectedSurface
    try {
        $codexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        $runtimeTools = @()
        if ($codexSmoke.authenticated_smoke -and $codexSmoke.authenticated_smoke.PSObject.Properties.Name -contains 'list_tools') {
            $runtimeTools = @($codexSmoke.authenticated_smoke.list_tools | Sort-Object -Unique)
        }
        return [pscustomobject]@{
            ok = $codexSmoke.ok -eq $true
            runtime_schema = [pscustomobject]@{
                source = 'authenticated MCP tool list'
                count = $runtimeTools.Count
                tools = $runtimeTools
                smoke_ok = $codexSmoke.ok
            }
            comparison = Compare-ToolSurface -ExpectedTools $expectedTools -RuntimeTools $runtimeTools
            smoke = $codexSmoke
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            runtime_schema = [pscustomobject]@{ source = 'authenticated MCP tool list'; count = 0; tools = @(); smoke_ok = $false }
            comparison = [pscustomobject]@{ ok = $false; status = 'RUNTIME_TOOLS_UNAVAILABLE'; expected_count = $expectedTools.Count; runtime_count = 0; missing_count = $null; unexpected_count = $null; missing = @(); unexpected = @(); error = Sanitize-Text $_.Exception.Message }
        }
    }
}

function Invoke-ChatgptConnectorRefresh {
    param(
        [switch]$Startup
    )

    Ensure-Directories

    $legacyRefreshEnabled = $env:CONSOLE_MCP_ENABLE_LEGACY_CONNECTOR_REFRESH -in @('1', 'true', 'yes')
    if (-not $legacyRefreshEnabled) {
        $deprecated = [pscustomobject]@{
            ok = $true
            status = 'DEPRECATED_NOOP'
            skipped = $true
            deprecated = $true
            reason = 'ChatGPT Web UI no longer exposes connector refresh; schema propagation is expected to be asynchronous or handled by reconnect.'
            at = (Get-Date).ToString('o')
            state_file = $ConnectorRefreshStateFile
            next_action = 'none'
        }
        $deprecated | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        return ($deprecated | ConvertTo-Json -Depth 10)
    }

    $timeoutSeconds = if ($Startup) { 20 } else { 60 }
    if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_TIMEOUT_SECONDS) {
        $parsed = 0
        if ([int]::TryParse($env:CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_TIMEOUT_SECONDS, [ref]$parsed) -and $parsed -gt 0) {
            $timeoutSeconds = $parsed
        }
    }

    $connectorName = if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_NAME) { $env:CONSOLE_MCP_CHATGPT_CONNECTOR_NAME.Trim() } else { 'console-mcp' }
    $connectorId = if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_ID) { $env:CONSOLE_MCP_CHATGPT_CONNECTOR_ID.Trim() } else { 'asdk_app_6a387987d2f881918ffe72c70002307c' }
    $ports = if ($env:CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS) { $env:CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS.Trim() } else { '9222,9223' }
    $scriptPath = Join-Path $Root 'tool\chatgpt-connector-refresh.mjs'
    $node = Get-NodeCommand
    $exitCode = 1

    try {
        $output = & $node.Source $scriptPath --name $connectorName --connectorId $connectorId --ports $ports --timeout-sec $timeoutSeconds 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        $output = @((Sanitize-Text $_.Exception.Message))
        $exitCode = 1
    }

    $raw = (($output | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $raw = '{"ok":false,"status":"empty-refresh-output"}'
    }

    Write-SafeLogLine -Path $ConnectorRefreshLogFile -Text $raw
    try {
        $parsedResult = $raw | ConvertFrom-Json
        $parsedResult | Add-Member -NotePropertyName at -NotePropertyValue (Get-Date).ToString('o') -Force
        $parsedResult | Add-Member -NotePropertyName exit_code -NotePropertyValue $exitCode -Force
        $parsedResult | Add-Member -NotePropertyName startup_hook -NotePropertyValue ([bool]$Startup) -Force
        $parsedResult | Add-Member -NotePropertyName state_file -NotePropertyValue $ConnectorRefreshStateFile -Force
        $runtimeSurface = Get-RuntimeToolSurfaceReport
        $parsedResult | Add-Member -NotePropertyName runtime_schema -NotePropertyValue $runtimeSurface.runtime_schema -Force
        $parsedResult | Add-Member -NotePropertyName runtime_schema_comparison -NotePropertyValue $runtimeSurface.comparison -Force
        $parsedResult | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        if (-not $Startup -and -not $parsedResult.ok) {
            throw "ChatGPT connector refresh failed: $($parsedResult.status)"
        }
        return ($parsedResult | ConvertTo-Json -Depth 20)
    } catch {
        if ($_.Exception.Message -like 'ChatGPT connector refresh failed:*') {
            throw
        }
        $fallback = [pscustomobject]@{
            ok = $false
            status = 'refresh-output-unparseable'
            at = (Get-Date).ToString('o')
            exit_code = $exitCode
            startup_hook = [bool]$Startup
            state_file = $ConnectorRefreshStateFile
            raw = $raw
            error = Sanitize-Text $_.Exception.Message
        }
        $fallback | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        if (-not $Startup) {
            throw "ChatGPT connector refresh failed: $($fallback.error)"
        }
        return ($fallback | ConvertTo-Json -Depth 10)
    }
}

function Wait-PublicSmokeReady {
    param(
        [int]$TimeoutSeconds = 30,
        [int]$IntervalSeconds = 2
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    $stableCount = 0

    while ((Get-Date) -lt $deadline) {
        $last = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        if ($last.ok -eq $true) {
            $stableCount++
            if ($stableCount -ge 2) {
                $last | Add-Member -NotePropertyName stable_success_count -NotePropertyValue $stableCount -Force
                return $last
            }
        } else {
            $stableCount = 0
        }

        Start-Sleep -Seconds $IntervalSeconds
    }

    throw ("public smoke did not become stably ready within {0} seconds. Last result: {1}" -f $TimeoutSeconds, (($last | ConvertTo-Json -Depth 8 -Compress)))
}

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

function Invoke-ChatgptBrowserSessionCli {
    param(
        [Parameter(Mandatory = $true)][string]$CliCommand,
        [string[]]$Arguments = @()
    )
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "ChatGPT browser session CLI is missing: $scriptPath"
    }
    Push-Location $Root
    try {
        & $node.Source --enable-source-maps $scriptPath $CliCommand @Arguments
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

function Invoke-ChatgptSessionWarmth {
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-session-warmth 2>&1
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_CHECK_FAILED'; error = Sanitize-Text (($raw | Out-String).Trim()); state_file = (Join-Path $RunDir 'chatgpt-session-warmth.json') }
    }
    return ($raw | Out-String | ConvertFrom-Json)
}

function Invoke-ChatgptSessionWarmthRepair {
    param([switch]$ConfirmRepair)

    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $arguments = @('chatgpt-session-warmth-repair')
    if ($ConfirmRepair) {
        $arguments += '-ConfirmRepair'
    }
    $raw = & $node.Source --enable-source-maps $scriptPath @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $warmth = Invoke-ChatgptSessionWarmth
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_REPAIR_FAILED'; error = Sanitize-Text (($raw | Out-String).Trim()); before_warmth = $warmth; repair_action = 'failed'; prune_result = $null; after_warmth = $warmth }
    }
    return ($raw | Out-String | ConvertFrom-Json)
}

function Get-ServerLifecycleLogTail {
    param([int]$MaxLines = 80)
    if (-not (Test-Path -LiteralPath $ServerLifecycleLogFile -PathType Leaf)) { return @() }
    return @(Get-Content -LiteralPath $ServerLifecycleLogFile -Tail $MaxLines -ErrorAction SilentlyContinue)
}

function Get-CompactGitLifecycleSummary {
    $head = $null
    $statusLines = @()
    Push-Location $Root
    try {
        $head = ((& git rev-parse --short HEAD 2>$null) | Select-Object -First 1)
        $statusLines = @(& git status --short 2>$null)
    } catch {
        $statusLines = @('git_status_unavailable')
    } finally {
        Pop-Location
    }
    return [pscustomobject]@{ head = if ($head) { [string]$head } else { $null }; dirty_count = @($statusLines).Count; status = @($statusLines | Select-Object -First 40) }
}

function Get-ServerLifecyclePromptSha256 {
    param([string]$PromptFile = $ServerLifecyclePromptFile)
    if ([string]::IsNullOrWhiteSpace($PromptFile) -or -not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { return $null }
    $stream = [System.IO.File]::OpenRead($PromptFile)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-TextSha256 {
    param([string]$Text = '')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-ServerLifecycleSuggestedChatTitleFull {
    if (Test-Path -LiteralPath $ServerLifecyclePromptFile -PathType Leaf) {
        $text = Get-Content -LiteralPath $ServerLifecyclePromptFile -Raw
        $match = [regex]::Match($text, '(?m)^- suggested chat title:\s*(.+)$')
        if ($match.Success) { return $match.Groups[1].Value.Trim() }
    }
    return ('Console MCP Lifecycle Review ' + (Get-Date).ToString('yyyy-MM-dd HH:mm'))
}

function Get-ServerLifecycleId6 {
    param([string]$ChatId = $null, [string]$TargetId = $null)
    if (-not [string]::IsNullOrWhiteSpace($ChatId)) { return $ChatId.Trim().Substring(0, [Math]::Min(6, $ChatId.Trim().Length)) }
    if (-not [string]::IsNullOrWhiteSpace($TargetId)) { return $TargetId.Trim().Substring(0, [Math]::Min(6, $TargetId.Trim().Length)) }
    return 'none'
}

function Get-ServerLifecycleTitleIdSource {
    param([string]$ChatId = $null, [string]$TargetId = $null, [string]$PromptFile = $ServerLifecyclePromptFile)
    if (-not [string]::IsNullOrWhiteSpace($ChatId)) {
        return [pscustomobject]@{ source = 'chat_id'; value = $ChatId.Trim().Substring(0, [Math]::Min(6, $ChatId.Trim().Length)) }
    }
    if (-not [string]::IsNullOrWhiteSpace($TargetId)) {
        return [pscustomobject]@{ source = 'target_id'; value = $TargetId.Trim().Substring(0, [Math]::Min(6, $TargetId.Trim().Length)) }
    }
    $promptSha256 = Get-ServerLifecyclePromptSha256 -PromptFile $PromptFile
    if (-not [string]::IsNullOrWhiteSpace($promptSha256)) {
        return [pscustomobject]@{ source = 'prompt_sha256'; value = $promptSha256.Substring(0, 6) }
    }
    return [pscustomobject]@{ source = 'none'; value = 'none' }
}

function Get-NewestAssistantMessageText {
    param([object]$Capture)
    $messages = @()
    try { $messages = @($Capture.messages) } catch { $messages = @() }
    for ($index = $messages.Count - 1; $index -ge 0; $index--) {
        $message = $messages[$index]
        $role = $null
        $text = $null
        try { $role = [string]$message.role } catch { $role = $null }
        try { $text = [string]$message.text } catch { $text = $null }
        if ($role -eq 'assistant') { return $text }
    }
    return $null
}

function Test-FinalAssistantLifecycleAnswer {
    param([string]$Text = $null)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $trimmed = $Text.Trim()
    return -not [regex]::IsMatch($trimmed, '^(?i:thinking(?:[.\s]|\u2026)*$)')
}

function Invoke-ChatgptLifecycleAnswerCapture {
    param([string]$ChatId = $null, [string]$TargetId = $null, [int]$TimeoutSeconds = 240)
    if ([string]::IsNullOrWhiteSpace($ChatId)) {
        return [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $null; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'submit must resolve chat_id before answer capture' }
    }
    Ensure-BuildOutput | Out-Null
    Ensure-Directories
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastCapture = $null
    $lastAssistantText = $null
    $stableAssistantText = $null
    $stablePollCount = 0
    while ((Get-Date) -lt $deadline) {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-capture -ChatId $ChatId -TimeoutMs 10000 2>&1
        try {
            $lastCapture = ($raw | Out-String | ConvertFrom-Json -ErrorAction Stop)
        } catch {
            return [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $ChatId; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'inspect chatgpt-capture output'; error = Sanitize-Text (($raw | Out-String).Trim()) }
        }
        if ($lastCapture.ok -eq $true) {
            $lastAssistantText = Get-NewestAssistantMessageText -Capture $lastCapture
            if (Test-FinalAssistantLifecycleAnswer -Text $lastAssistantText) {
                if ($stableAssistantText -eq $lastAssistantText) { $stablePollCount++ } else { $stableAssistantText = $lastAssistantText; $stablePollCount = 1 }
                if ($stablePollCount -ge 2) {
                    $id6 = Get-ServerLifecycleId6 -ChatId $ChatId -TargetId $TargetId
                    $answerPath = Join-Path $RunDir ('server-lifecycle-answer-{0}.md' -f $id6)
                    Set-Content -LiteralPath $answerPath -Value $lastAssistantText -Encoding utf8
                    $hash = Get-TextSha256 -Text $lastAssistantText
                    return [pscustomobject]@{ ok = $true; status = 'ANSWER_CAPTURED'; chat_id = $ChatId; assistant_message_count = [int]$lastCapture.assistant_message_count; assistant_answer_length = $lastAssistantText.Length; assistant_answer_hash = $hash; captured_answer_path = $answerPath; retryable = $false; next_action = 'prepare Codex handoff' }
                }
            } else {
                $stableAssistantText = $null
                $stablePollCount = 0
            }
        }
        Start-Sleep -Seconds 5
    }
    $assistantCount = 0
    try { $assistantCount = [int]$lastCapture.assistant_message_count } catch { $assistantCount = 0 }
    $answerLength = if ($lastAssistantText) { $lastAssistantText.Length } else { 0 }
    $status = if ($assistantCount -gt 0 -and $answerLength -eq 0) { 'ANSWER_CAPTURE_EMPTY' } else { 'ANSWER_CAPTURE_TIMEOUT' }
    return [pscustomobject]@{ ok = $false; status = $status; chat_id = $ChatId; assistant_message_count = $assistantCount; assistant_answer_length = $answerLength; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'retry answer capture after ChatGPT finishes responding' }
}

function New-ServerLifecycleCodexHandoff {
    param([object]$AnswerCapture, [string]$ChatId = $null, [string]$TargetId = $null, [bool]$ExecuteRequested = $false)
    if (-not $AnswerCapture -or $AnswerCapture.ok -ne $true -or [string]::IsNullOrWhiteSpace([string]$AnswerCapture.captured_answer_path)) {
        return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_SKIPPED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $ExecuteRequested; executed = $false; next_action = 'capture assistant answer before preparing Codex handoff' }
    }
    $answerPath = [string]$AnswerCapture.captured_answer_path
    if (-not (Test-Path -LiteralPath $answerPath -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_FAILED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $ExecuteRequested; executed = $false; next_action = 'captured answer file missing' }
    }
    $id6 = Get-ServerLifecycleId6 -ChatId $ChatId -TargetId $TargetId
    $branchName = 'fix/lifecycle-diagnostic-remediation-{0}-{1}' -f (Get-Date).ToString('yyyyMMdd-HHmm'), $id6
    $handoffPath = Join-Path $RunDir ('server-lifecycle-codex-handoff-{0}.md' -f $id6)
    $answerText = Get-Content -LiteralPath $answerPath -Raw
    $mixin = @(
        ('You are Codex CLI working on {0}.' -f $Root),
        ('Create or use a separate branch named {0}.' -f $branchName),
        'Do not work directly on master.',
        'Do not restart the server stack unless explicitly required.',
        'Read the diagnostic assistant answer below unchanged.',
        'Implement only issues that are explicitly marked as not ready, risky, fragile, broken, missing, or incomplete.',
        'Execute fixes from cheapest/safest to most expensive/risky.',
        'Prefer small isolated patches.',
        'Run build/typecheck/smoke gates.',
        'Do not merge to master.',
        'Return changed files, commits, gates, and remaining risks.'
    ) -join [Environment]::NewLine
    $handoff = $mixin + [Environment]::NewLine + [Environment]::NewLine + 'Diagnostic assistant answer:' + [Environment]::NewLine + [Environment]::NewLine + $answerText
    Set-Content -LiteralPath $handoffPath -Value $handoff -Encoding utf8
    if (-not $ExecuteRequested) {
        return [pscustomobject]@{ ok = $true; status = 'CODEX_HANDOFF_PREPARED'; handoff_prompt_path = $handoffPath; branch_name = $branchName; execute_requested = $false; executed = $false; next_action = 'run with -ExecuteCodexHandoff to execute Codex CLI handoff' }
    }
    return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_FAILED'; handoff_prompt_path = $handoffPath; branch_name = $branchName; execute_requested = $true; executed = $false; next_action = 'Codex CLI execution is intentionally not wired in this lifecycle wrapper yet; run the prepared prompt manually with full task permissions' }
}

function Get-ServerLifecycleSuggestedChatTitleMetadata {
    param([string]$ChatId = $null, [string]$TargetId = $null, [string]$PromptFile = $ServerLifecyclePromptFile)
    $full = Get-ServerLifecycleSuggestedChatTitleFull
    $datePart = $null
    $timePart = $null
    $match = [regex]::Match($full, '(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})')
    if ($match.Success) {
        $datePart = $match.Groups[2].Value + $match.Groups[3].Value
        $timePart = $match.Groups[4].Value + $match.Groups[5].Value
    }
    if ([string]::IsNullOrWhiteSpace($datePart)) { $datePart = (Get-Date).ToString('MMdd') }
    if ([string]::IsNullOrWhiteSpace($timePart)) { $timePart = (Get-Date).ToString('HHmm') }
    $id = Get-ServerLifecycleTitleIdSource -ChatId $ChatId -TargetId $TargetId -PromptFile $PromptFile
    $compact = 'MCP {0} {1} {2}' -f $datePart, $timePart, $id.value
    return [pscustomobject]@{
        suggested_chat_title_full = $full
        suggested_chat_title_compact = $compact
        title_id_source = $id.source
    }
}

function New-ServerLifecycleLaunchPrompt {
    param([string]$Operation = 'manual', [string]$Generation = $null, [string]$Mode = $null, [string]$Status = $null, [object]$Detail = $null)
    Ensure-Directories
    $git = Get-CompactGitLifecycleSummary
    try { $warmth = Invoke-ChatgptSessionWarmth } catch { $warmth = [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_UNAVAILABLE'; error = Sanitize-Text $_.Exception.Message } }
    $tail = Get-ServerLifecycleLogTail -MaxLines 80
    $suggestedTitle = 'Console MCP Lifecycle Review ' + (Get-Date).ToString('yyyy-MM-dd HH:mm')
    $issueCount = 0
    if ($warmth -and $warmth.ok -ne $true) { $issueCount++ }
    if ($git.dirty_count -gt 0) { $issueCount++ }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @(
        'Console MCP server lifecycle completed.', '', 'Lifecycle summary:',
        ('- operation: {0}' -f $Operation), ('- generation: {0}' -f $(if ($Generation) { $Generation } else { 'n/a' })),
        ('- mode: {0}' -f $(if ($Mode) { $Mode } else { 'n/a' })), ('- status: {0}' -f $(if ($Status) { $Status } else { 'n/a' })),
        ('- git head: {0}' -f $(if ($git.head) { $git.head } else { 'unknown' })), ('- git dirty count: {0}' -f $git.dirty_count),
        ('- ChatGPT session warmth: {0}' -f $(if ($warmth.status) { $warmth.status } else { 'unknown' })), ('- suggested chat title: {0}' -f $suggestedTitle),
        '', 'Compact lifecycle log tail:'
    )) { $lines.Add($line) | Out-Null }
    if ($tail.Count -gt 0) { foreach ($line in $tail) { $lines.Add($line) | Out-Null } } else { $lines.Add('(empty)') | Out-Null }
    $lines.Add('') | Out-Null
    $lines.Add('Git status:') | Out-Null
    if ($git.status.Count -gt 0) { foreach ($line in $git.status) { $lines.Add(('- {0}' -f $line)) | Out-Null } } else { $lines.Add('- clean') | Out-Null }
    foreach ($line in @(
        '', 'Task:',
        'Go to the console-mcp repository and perform a deep technical review of the current lifecycle/startup/watchdog/browser automation implementation.',
        '', 'Focus:', '1. bugs and fragility', '2. SOLID violations', '3. lifecycle anti-patterns', '4. noisy logs and over-nested JSON',
        '5. unsafe restart/relaunch behavior', '6. duplicated responsibilities between dev-console.ps1, browser-session executor, watchdog, and MCP tools',
        '7. exact files/functions that should be changed next', '', 'Return:', '- concise findings', '- risk level', '- exact files/functions', '- safe next patch proposal'
    )) { $lines.Add($line) | Out-Null }
    $prompt = ($lines -join [Environment]::NewLine)
    Set-Content -LiteralPath $ServerLifecyclePromptFile -Value $prompt -Encoding utf8
    $titleMetadata = Get-ServerLifecycleSuggestedChatTitleMetadata -PromptFile $ServerLifecyclePromptFile
    return [pscustomobject]@{ ok = $true; status = 'SERVER_LIFECYCLE_PROMPT_READY'; prompt_file = $ServerLifecyclePromptFile; prompt_length = $prompt.Length; lifecycle_log_file = $ServerLifecycleLogFile; issue_count = $issueCount; suggested_chat_title = $titleMetadata.suggested_chat_title_compact; suggested_chat_title_full = $titleMetadata.suggested_chat_title_full; suggested_chat_title_compact = $titleMetadata.suggested_chat_title_compact; title_id_source = $titleMetadata.title_id_source; next_action = 'chatgpt-send-lifecycle-review-prompt' }
}

function Invoke-ServerLifecyclePromptCommand {
    $result = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'MANUAL_PROMPT_REQUEST'
    return ($result | ConvertTo-Json -Depth 8)
}

function Invoke-ChatgptOpenRootTarget {
    param([int]$Port = 9223)
    $uri = "http://127.0.0.1:$Port/json/new?https://chatgpt.com/"
    try {
        $response = Invoke-WebRequest -Uri $uri -Method Put -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{ ok = [bool]($response.StatusCode -ge 200 -and $response.StatusCode -lt 300); status = 'CHATGPT_ROOT_TARGET_OPEN_REQUESTED'; port = $Port; http_status = [int]$response.StatusCode }
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_ROOT_TARGET_OPEN_FAILED'; port = $Port; error = Sanitize-Text $_.Exception.Message }
    }
}

function Wait-ChatgptLifecycleReviewRootReady {
    param([int]$TimeoutSeconds = 20)
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-preflight 2>&1
        try { $last = ($raw | Out-String | ConvertFrom-Json) } catch { $last = [pscustomobject]@{ ok = $false; status = 'CHATGPT_PREFLIGHT_OUTPUT_UNPARSEABLE'; raw = Sanitize-Text (($raw | Out-String).Trim()) } }
        if ($last.ok -eq $true -and $last.status -eq 'COMPOSER_PREFLIGHT_READY') {
            return [pscustomobject]@{ ok = $true; status = 'CHATGPT_LIFECYCLE_REVIEW_ROOT_READY'; preflight = $last }
        }
        Start-Sleep -Milliseconds 500
    }
    return [pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_ROOT_NOT_READY'; preflight = $last }
}

function Invoke-ChatgptOpenNewChat {
    param([string[]]$Arguments = @())
    $confirmOpen = @($Arguments) -contains '-ConfirmOpen' -or @($Arguments) -contains '--confirm-open'
    $transportIndex = [Array]::IndexOf($Arguments, '-PromptTransport')
    if ($transportIndex -lt 0) { $transportIndex = [Array]::IndexOf($Arguments, '--prompt-transport') }
    $promptTransport = if ($transportIndex -ge 0 -and $Arguments.Count -gt ($transportIndex + 1)) { [string]$Arguments[$transportIndex + 1] } else { 'INLINE_TEXT' }
    if ($promptTransport -notin @('INLINE_TEXT', 'FILE_ATTACHMENT')) { $promptTransport = 'INLINE_TEXT' }
    $warmthBefore = Invoke-ChatgptSessionWarmth
    $readyBefore = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5
    if ($readyBefore.ok -eq $true) {
        return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $readyBefore; next_action = 'chatgpt-submit-ready-chat' } | ConvertTo-Json -Depth 30)
    }
    if (-not $confirmOpen) {
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_OPEN_CONFIRM_REQUIRED'; warmth_before = $warmthBefore; root_ready = $readyBefore; next_action = 'rerun with -ConfirmOpen' } | ConvertTo-Json -Depth 30)
    }

    if ($warmthBefore.root_target_count -gt 1) {
        $keepTargetId = $null
        try { $keepTargetId = [string]$warmthBefore.inventory_summary.selected_target_candidates[0].id } catch { $keepTargetId = $null }
        if ([string]::IsNullOrWhiteSpace($keepTargetId)) {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_ROOT_PRUNE_KEEP_TARGET_UNRESOLVED'; warmth_before = $warmthBefore; next_action = 'inspect root target candidates' } | ConvertTo-Json -Depth 30)
        }
        Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-prune-root-targets' -Arguments @('-KeepTargetId', $keepTargetId, '-ConfirmCleanup') | Out-Null
        $warmthBefore = Invoke-ChatgptSessionWarmth
    }

    $discardedDirtyRoot = $null
    if ($warmthBefore.root_target_count -gt 0) {
        $rootReady = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20
        if ($rootReady.ok -eq $true) {
            return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; next_action = 'chatgpt-submit-ready-chat' } | ConvertTo-Json -Depth 30)
        }

        $dirtyRootTargetId = $null
        $dirtyRootTextLength = $null
        $dirtyRootMessageCount = $null
        try {
            $rejection = $rootReady.preflight.candidate_rejections[0]
            if ($rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) {
                $dirtyRootTargetId = [string]$rejection.target_id
                $dirtyRootTextLength = [int]$rejection.composer_text_length
                $dirtyRootMessageCount = [int]$rejection.message_count
            }
        } catch { $dirtyRootTargetId = $null }

        if ([string]::IsNullOrWhiteSpace($dirtyRootTargetId)) {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_ROOT_NOT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; next_action = 'inspect existing root target readiness' } | ConvertTo-Json -Depth 30)
        }

        if ($promptTransport -eq 'FILE_ATTACHMENT') {
            return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_DIRTY_ROOT_ACCEPTED_FOR_ATTACHMENT_TRANSPORT'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; dirty_root = [pscustomobject]@{ target_id = $dirtyRootTargetId; composer_text_length = $dirtyRootTextLength; message_count = $dirtyRootMessageCount }; next_action = 'chatgpt-submit-ready-chat with FILE_ATTACHMENT and AllowOverwrite' } | ConvertTo-Json -Depth 30)
        }

        try {
            $closeUri = "http://127.0.0.1:9223/json/close/$dirtyRootTargetId"
            $closeResponse = Invoke-WebRequest -Uri $closeUri -Method Get -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
            $discardedDirtyRoot = [pscustomobject]@{ ok = [bool]($closeResponse.StatusCode -ge 200 -and $closeResponse.StatusCode -lt 300); status = 'CHATGPT_DIRTY_ROOT_TARGET_CLOSED'; target_id = $dirtyRootTargetId; composer_text_length = $dirtyRootTextLength; message_count = $dirtyRootMessageCount; http_status = [int]$closeResponse.StatusCode }
        } catch {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_DIRTY_ROOT_TARGET_CLOSE_FAILED'; warmth_before = $warmthBefore; root_ready = $rootReady; target_id = $dirtyRootTargetId; error = Sanitize-Text $_.Exception.Message; next_action = 'manual close dirty root target' } | ConvertTo-Json -Depth 30)
        }
        Start-Sleep -Milliseconds 500
        $warmthBefore = Invoke-ChatgptSessionWarmth
    }

    $openRoot = Invoke-ChatgptOpenRootTarget -Port 9223
    if ($openRoot.ok -ne $true) {
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_OPEN_FAILED'; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; next_action = 'inspect CDP target creation' } | ConvertTo-Json -Depth 30)
    }
    $rootReady = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20
    $ok = [bool]($rootReady.ok -eq $true)
    if (-not $ok -and $promptTransport -eq 'FILE_ATTACHMENT') {
        try {
            $rejection = $rootReady.preflight.candidate_rejections[0]
            if ($rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) {
                return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_OPENED_DIRTY_ROOT_ACCEPTED_FOR_ATTACHMENT_TRANSPORT'; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; root_ready = $rootReady; dirty_root = [pscustomobject]@{ target_id = [string]$rejection.target_id; composer_text_length = [int]$rejection.composer_text_length; message_count = [int]$rejection.message_count }; next_action = 'chatgpt-submit-ready-chat with FILE_ATTACHMENT and AllowOverwrite' } | ConvertTo-Json -Depth 30)
            }
        } catch { }
    }
    return ([pscustomobject]@{ ok = $ok; status = if ($ok) { 'CHATGPT_NEW_CHAT_OPENED_READY' } else { 'CHATGPT_NEW_CHAT_ROOT_NOT_READY' }; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; root_ready = $rootReady; next_action = if ($ok) { 'chatgpt-submit-ready-chat' } else { 'inspect root_ready diagnostics' } } | ConvertTo-Json -Depth 30)
}

function Invoke-ChatgptSubmitReadyChat {
    param([string[]]$Arguments = @())
    $confirmSubmit = @($Arguments) -contains '-ConfirmSend' -or @($Arguments) -contains '--confirm-send'
    $promptIndex = [Array]::IndexOf($Arguments, '-PromptFile')
    if ($promptIndex -lt 0) { $promptIndex = [Array]::IndexOf($Arguments, '--prompt-file') }
    $promptFile = if ($promptIndex -ge 0 -and $Arguments.Count -gt ($promptIndex + 1)) { [string]$Arguments[$promptIndex + 1] } else { $null }
    $transportIndex = [Array]::IndexOf($Arguments, '-PromptTransport')
    if ($transportIndex -lt 0) { $transportIndex = [Array]::IndexOf($Arguments, '--prompt-transport') }
    $promptTransport = if ($transportIndex -ge 0 -and $Arguments.Count -gt ($transportIndex + 1)) { [string]$Arguments[$transportIndex + 1] } else { 'INLINE_TEXT' }
    if ($promptTransport -notin @('INLINE_TEXT', 'FILE_ATTACHMENT')) { $promptTransport = 'INLINE_TEXT' }
    if (-not $confirmSubmit) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_SUBMIT_CONFIRM_REQUIRED'; prompt_file = $promptFile; prompt_transport = $promptTransport; next_action = 'rerun with -ConfirmSend' } | ConvertTo-Json -Depth 8) }
    if ([string]::IsNullOrWhiteSpace($promptFile) -or -not (Test-Path -LiteralPath $promptFile -PathType Leaf)) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_PROMPT_FILE_MISSING'; prompt_file = $promptFile; prompt_transport = $promptTransport; next_action = 'provide -PromptFile' } | ConvertTo-Json -Depth 8) }
    $preflight = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5
    $submitExistingTargetId = $null
    if ($preflight.ok -ne $true) {
        try {
            $rejection = $preflight.preflight.candidate_rejections[0]
            if ($promptTransport -eq 'INLINE_TEXT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and $rejection.send_control_enabled -eq $true) { $submitExistingTargetId = [string]$rejection.target_id }
            if ($promptTransport -eq 'FILE_ATTACHMENT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) { $submitExistingTargetId = $null }
        } catch { $submitExistingTargetId = $null }
        if ([string]::IsNullOrWhiteSpace($submitExistingTargetId)) {
            $attachmentDirtyRootAccepted = $false
            try {
                $rejection = $preflight.preflight.candidate_rejections[0]
                $attachmentDirtyRootAccepted = [bool]($promptTransport -eq 'FILE_ATTACHMENT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0)
            } catch { $attachmentDirtyRootAccepted = $false }
            if (-not $attachmentDirtyRootAccepted) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_NOT_READY'; prompt_file = $promptFile; prompt_transport = $promptTransport; preflight = $preflight; next_action = 'run chatgpt-open-new-chat -ConfirmOpen' } | ConvertTo-Json -Depth 30) }
        }
    }
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    if ([string]::IsNullOrWhiteSpace($submitExistingTargetId)) {
        $sendArgs = @('chatgpt-send', '-PromptFile', $promptFile, '-PromptTransport', $promptTransport, '-ConfirmSend')
        if ($promptTransport -eq 'FILE_ATTACHMENT') { $sendArgs += '-AllowOverwrite' }
        $raw = & $node.Source --enable-source-maps $scriptPath @sendArgs 2>&1
    } else {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-submit -TargetId $submitExistingTargetId -ConfirmSubmit 2>&1
    }
    $exitCode = $LASTEXITCODE
    try { $parsed = ($raw | Out-String | ConvertFrom-Json) } catch { $parsed = [pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_SUBMIT_OUTPUT_UNPARSEABLE'; raw = Sanitize-Text (($raw | Out-String).Trim()) } }
    $ok = [bool]($exitCode -eq 0 -and $parsed.ok -eq $true)
    return ([pscustomobject]@{ ok = $ok; status = if ($ok) { 'CHATGPT_READY_CHAT_SUBMIT_DONE' } else { 'CHATGPT_READY_CHAT_SUBMIT_FAILED' }; prompt_file = $promptFile; prompt_transport = $promptTransport; target_id = $parsed.target_id; chat_id = $parsed.chat_id; submitted = $parsed.submitted; preflight = $preflight; submit = $parsed; next_action = if ($ok) { 'rename lifecycle review chat' } else { 'inspect submit result' } } | ConvertTo-Json -Depth 30)
}

function Get-ServerLifecycleSuggestedChatTitle { return (Get-ServerLifecycleSuggestedChatTitleMetadata).suggested_chat_title_compact }
function Invoke-ChatgptRenameLifecycleReviewChat { param([string[]]$Arguments=@(), [string]$ChatId=$null, [string]$TargetId=$null, [string]$PromptFile=$ServerLifecyclePromptFile); $confirmRename=@($Arguments)-contains '-ConfirmRename' -or @($Arguments)-contains '--confirm-rename'; $titleMetadata=Get-ServerLifecycleSuggestedChatTitleMetadata -ChatId $ChatId -TargetId $TargetId -PromptFile $PromptFile; $title=$titleMetadata.suggested_chat_title_compact; if(-not $confirmRename){return ([pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_CONFIRM_REQUIRED';suggested_chat_title=$title;suggested_chat_title_full=$titleMetadata.suggested_chat_title_full;suggested_chat_title_compact=$titleMetadata.suggested_chat_title_compact;title_id_source=$titleMetadata.title_id_source;next_action='rerun with -ConfirmRename'}|ConvertTo-Json -Depth 30)}; Ensure-BuildOutput|Out-Null; $node=Get-Command node -ErrorAction Stop; $scriptPath=Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'; $raw=& $node.Source --enable-source-maps $scriptPath chatgpt-rename-latest -Title $title 2>&1; $text=($raw|Out-String).Trim(); try{$rename=$text|ConvertFrom-Json -ErrorAction Stop}catch{$rename=[pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_PARSE_FAILED';raw=$text}}; return ([pscustomobject]@{ok=[bool]($rename.ok -eq $true);status=if($rename.ok -eq $true){'CHATGPT_LIFECYCLE_RENAME_DONE'}else{'CHATGPT_LIFECYCLE_RENAME_FAILED'};suggested_chat_title=$title;suggested_chat_title_full=$titleMetadata.suggested_chat_title_full;suggested_chat_title_compact=$titleMetadata.suggested_chat_title_compact;title_id_source=$titleMetadata.title_id_source;rename=$rename}|ConvertTo-Json -Depth 40) }
function Invoke-ChatgptSendLifecycleReviewPrompt {
    param([string[]]$Arguments = @())
    $confirmSend = @($Arguments) -contains '-ConfirmSend' -or @($Arguments) -contains '--confirm-send'
    $prepareCodexHandoff = $true
    if (@($Arguments) -contains '-PrepareCodexHandoff' -or @($Arguments) -contains '--prepare-codex-handoff') { $prepareCodexHandoff = $true }
    $executeCodexHandoff = @($Arguments) -contains '-ExecuteCodexHandoff' -or @($Arguments) -contains '--execute-codex-handoff'
    $promptTransport = 'FILE_ATTACHMENT'
    if (-not $confirmSend) {
        $plan = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_REQUIRES_CONFIRMATION'
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_SEND_CONFIRM_REQUIRED'; prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $plan.suggested_chat_title; suggested_chat_title_full = $plan.suggested_chat_title_full; suggested_chat_title_compact = $plan.suggested_chat_title_compact; title_id_source = $plan.title_id_source; next_action = 'rerun with -ConfirmSend' } | ConvertTo-Json -Depth 8)
    }
    $plan = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_CONFIRMED'
    $openParsed = (Invoke-ChatgptOpenNewChat -Arguments @('-ConfirmOpen', '-PromptTransport', $promptTransport)) | ConvertFrom-Json
    if ($openParsed.ok -ne $true) {
        $state = [pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_OPEN_FAILED'; at = (Get-Date).ToString('o'); prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $plan.suggested_chat_title; suggested_chat_title_full = $plan.suggested_chat_title_full; suggested_chat_title_compact = $plan.suggested_chat_title_compact; title_id_source = $plan.title_id_source; open = $openParsed; state_file = $ServerLifecycleSendStateFile; next_action = 'inspect open result' }
        $json = ConvertTo-SafeBrowserAutomationJson -Value $state -Depth 30
        $json | Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8
        return $json
    }
    $submitParsed = (Invoke-ChatgptSubmitReadyChat -Arguments @('-PromptFile', $plan.prompt_file, '-PromptTransport', $promptTransport, '-ConfirmSend')) | ConvertFrom-Json
    $renameParsed = $null
    if ($submitParsed.ok -eq $true) { $renameParsed = (Invoke-ChatgptRenameLifecycleReviewChat -Arguments @('-ConfirmRename') -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file) | ConvertFrom-Json }
    $answerCapture = $null
    if ($submitParsed.ok -eq $true) {
        $answerCapture = Invoke-ChatgptLifecycleAnswerCapture -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id
    } else {
        $answerCapture = [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $submitParsed.chat_id; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'submit must complete before answer capture' }
    }
    if ($submitParsed.ok -eq $true -and $answerCapture.ok -eq $true -and (-not $renameParsed -or $renameParsed.ok -ne $true)) {
        $renameParsed = (Invoke-ChatgptRenameLifecycleReviewChat -Arguments @('-ConfirmRename') -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file) | ConvertFrom-Json
    }
    $codexHandoff = if ($prepareCodexHandoff -or $executeCodexHandoff) {
        New-ServerLifecycleCodexHandoff -AnswerCapture $answerCapture -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -ExecuteRequested $executeCodexHandoff
    } else {
        [pscustomobject]@{ ok = $true; status = 'CODEX_HANDOFF_SKIPPED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $false; executed = $false; next_action = 'rerun with -PrepareCodexHandoff to prepare Codex handoff' }
    }
    $titleMetadata = if ($renameParsed) { $renameParsed } else { Get-ServerLifecycleSuggestedChatTitleMetadata -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file }
    $ok = [bool]($submitParsed.ok -eq $true -and ($null -eq $renameParsed -or $renameParsed.ok -eq $true) -and $answerCapture.ok -eq $true -and $codexHandoff.ok -eq $true)
    $status = if ($ok) { 'CHATGPT_LIFECYCLE_REVIEW_SEND_RENAME_CAPTURE_HANDOFF_DONE' } elseif ($submitParsed.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_SEND_FAILED' } elseif (-not $renameParsed -or $renameParsed.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_RENAME_FAILED' } elseif ($answerCapture.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_ANSWER_CAPTURE_FAILED' } else { 'CHATGPT_LIFECYCLE_REVIEW_CODEX_HANDOFF_FAILED' }
    $state = [pscustomobject]@{ ok = $ok; status = $status; at = (Get-Date).ToString('o'); prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $titleMetadata.suggested_chat_title_compact; suggested_chat_title_full = $titleMetadata.suggested_chat_title_full; suggested_chat_title_compact = $titleMetadata.suggested_chat_title_compact; title_id_source = $titleMetadata.title_id_source; open = $openParsed; submit = $submitParsed; rename = $renameParsed; answer_capture = $answerCapture; codex_handoff = $codexHandoff; state_file = $ServerLifecycleSendStateFile; next_action = if ($ok) { 'done' } elseif ($submitParsed.ok -ne $true) { 'inspect submit result' } elseif (-not $renameParsed -or $renameParsed.ok -ne $true) { 'inspect rename result' } elseif ($answerCapture.ok -ne $true) { 'inspect answer_capture result' } elseif ($codexHandoff.ok -ne $true) { 'inspect codex_handoff result' } else { 'inspect lifecycle result' } }
    $json = ConvertTo-SafeBrowserAutomationJson -Value $state -Depth 30
    $json | Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8
    return $json
}

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

function Invoke-BrowserRelaunchVisible {
    param([string]$Purpose = 'manual')

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
    'stop-server' { Stop-ServerForWatchdogRecovery }
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
    'start-chatgpt-oauth' { Start-ChatgptOauth }
    'stop-chatgpt-oauth' { Stop-ChatgptOauth }
    'restart-chatgpt-oauth' {
        Invoke-SingleServiceSupervisedRestart -Kind 'chatgpt' -Mode 'warm'
    }
    'restart-chatgpt-oauth-soft' { Invoke-SingleServiceSupervisedRestart -Kind 'chatgpt' -Mode 'soft' }
    'restart-chatgpt-oauth-warm' { Invoke-SingleServiceSupervisedRestart -Kind 'chatgpt' -Mode 'warm' }
    'restart-chatgpt-oauth-cold' { Invoke-SingleServiceSupervisedRestart -Kind 'chatgpt' -Mode 'cold' }
    'runtime-replace-plan' { New-ConsoleDevRuntimeReplacePlan | ConvertTo-Json -Depth 30 }
    'runtime-replace-stale' { Invoke-ConsoleDevRuntimeReplaceStale }
    'start-codex-bearer' { Start-CodexBearer }
    'stop-codex-bearer' { Stop-CodexBearer }
    'restart-codex-bearer' {
        Invoke-SingleServiceSupervisedRestart -Kind 'codex' -Mode 'warm'
    }
    'restart-codex-bearer-soft' { Invoke-SingleServiceSupervisedRestart -Kind 'codex' -Mode 'soft' }
    'restart-codex-bearer-warm' { Invoke-SingleServiceSupervisedRestart -Kind 'codex' -Mode 'warm' }
    'restart-codex-bearer-cold' { Invoke-SingleServiceSupervisedRestart -Kind 'codex' -Mode 'cold' }
    'start-tunnel' {
        try {
            Start-Tunnel
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'stop-tunnel' { Stop-Tunnel }
    'restart-tunnel' {
        try {
            Stop-Tunnel
            Start-Tunnel | Out-Null
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'restart-all-plan' { Get-RestartAllPlan }
    'restart-all' {
        try {
            Invoke-RestartAllSupervised -Mode 'warm'
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'restart-all-soft' { Invoke-RestartAllSupervised -Mode 'soft' }
    'restart-all-warm' { Invoke-RestartAllSupervised -Mode 'warm' }
    'restart-all-cold' { Invoke-RestartAllSupervised -Mode 'cold' }
    'watchdog-heal' { Invoke-WatchdogHeal }
    'watchdog-status' { Get-WatchdogStateStatus | ConvertTo-Json -Depth 24 }
    'watchdog-freshness-status' { Get-WatchdogFreshnessStatus | ConvertTo-Json -Depth 20 }
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







