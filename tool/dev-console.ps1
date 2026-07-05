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
        'pre-signout',
        'post-login',
        'start-chatgpt-oauth',
        'stop-chatgpt-oauth',
        'restart-chatgpt-oauth',
        'start-codex-bearer',
        'stop-codex-bearer',
        'restart-codex-bearer',
        'restart-status',
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
        'restart-chatgpt-oauth-soft',
        'restart-chatgpt-oauth-warm',
        'restart-chatgpt-oauth-cold',
        'restart-codex-bearer-soft',
        'restart-codex-bearer-warm',
        'restart-codex-bearer-cold',
        'start-tunnel',
        'stop-tunnel',
        'restart-tunnel',
        'restart-all',
        'restart-all-soft',
        'restart-all-warm',
        'restart-all-cold',
        'watchdog-heal',
        'watchdog-status',
        'watchdog-freshness-status',
        'start-watchdog-loop',
        'stop-watchdog-loop',
        'restart-watchdog-loop',
        'watchdog-loop-status',
        'watchdog-loop-run',
        'install-watchdog-task',
        'uninstall-watchdog-task',
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
$ChatgptPidFile = Join-Path $RunDir 'console-mcp-chatgpt-oauth.pid'
$CodexPidFile = Join-Path $RunDir 'console-mcp-codex-bearer.pid'
$TunnelPidFile = Join-Path $RunDir 'cloudflared-console-mcp.pid'
$ChatgptLogFile = Join-Path $LogDir 'console-mcp-chatgpt-oauth.log'
$CodexLogFile = Join-Path $LogDir 'console-mcp-codex-bearer.log'
$TunnelLogFile = Join-Path $LogDir 'cloudflared-console-mcp.log'
$HttpTraceFile = Join-Path $TranscriptDir 'http-trace.ndjson'
$BuildInfoFile = Join-Path $RunDir 'console-mcp-build-info.json'
$RestartStateFile = Join-Path $RunDir 'console-mcp-restart-state.json'
$ExpectedSurfaceFile = Join-Path $RunDir 'console-mcp-expected-surface.json'
$ConnectorRefreshStateFile = Join-Path $RunDir 'chatgpt-connector-refresh.json'
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
$script:BuildOutputEnsured = $false
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
$StartupTaskName = 'console-mcp-chatgpt-oauth'
$WatchdogTaskName = 'console-mcp-watchdog'
$StartupTaskPath = '\'
$StartupTaskCommand = 'restart-all'
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
    'start-codex-bearer',
    'restart-codex-bearer',
    'restart-codex-bearer-soft',
    'restart-codex-bearer-warm',
    'restart-codex-bearer-cold',
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
    if ($script:BuildOutputEnsured) {
        return Get-BuildOutputReport
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

    $script:BuildOutputEnsured = $true
    $report = Get-BuildOutputReport
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $BuildInfoFile -Encoding utf8
    return $report
}

function Get-BuildOutputReport {
    $distIndex = Join-Path $Root 'dist/index.js'
    $distItem = Get-Item -LiteralPath $distIndex -ErrorAction SilentlyContinue
    $newestSource = Get-NewestBuildInput
    $buildNeeded = $true
    if ($distItem -and $newestSource) {
        $buildNeeded = $newestSource.LastWriteTimeUtc -gt $distItem.LastWriteTimeUtc
    } elseif ($distItem) {
        $buildNeeded = $false
    }

    return [pscustomobject]@{
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
        build_needed = [bool]$buildNeeded
        build_info_file = $BuildInfoFile
        build_info_written = Test-Path -LiteralPath $BuildInfoFile
    }
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
    $candidates = @()
    foreach ($path in @('src')) {
        $fullPath = Join-Path $Root $path
        if (Test-Path -LiteralPath $fullPath) {
            $candidates += Get-ChildItem -LiteralPath $fullPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.ts', '.json') }
        }
    }
    foreach ($file in @('package.json', 'tsconfig.json')) {
        $fullPath = Join-Path $Root $file
        if (Test-Path -LiteralPath $fullPath) {
            $candidates += Get-Item -LiteralPath $fullPath
        }
    }

    return ($candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
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

function Invoke-WatchdogHeal {
    $actions = @()
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

        $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $freshness = Get-ChatgptRuntimeFreshness
        if ($localChatgpt.ok -eq $true -and $freshness.ok -ne $true) {
            $actions += [pscustomobject]@{ action = 'restart-chatgpt-oauth-warm'; reason = 'local chatgpt oauth runtime was stale'; freshness = $freshness }
            $chatgptRuntimeRestarted = $true
            Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools (Get-DefaultExpectedSurface) | Out-Null
            $localChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
            $freshness = Get-ChatgptRuntimeFreshness
        }

        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            $actions += [pscustomobject]@{ action = 'start-tunnel'; reason = 'cloudflared tunnel was not running' }
            Start-Tunnel | Out-Null
        }

        $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        try {
            $browserRecovery = Invoke-BrowserEnsureVisible -Purpose 'watchdog-heal'
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
        $finalLocalChatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
        $finalPublic = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        $connectorRefresh = $null
        $browserOk = [bool]($browserRecovery -and $browserRecovery.ok -eq $true)
        if ($chatgptRuntimeRestarted -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $finalPublic.ok -eq $true) {
            if ($browserOk) {
                $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
                $actions += [pscustomobject]@{ action = 'refresh-chatgpt-connector'; reason = 'chatgpt oauth runtime was restarted'; refresh_status = $connectorRefresh.status; refresh_ok = $connectorRefresh.ok }
            } else {
                $connectorRefresh = [pscustomobject]@{ ok = $true; status = 'SKIPPED_BROWSER_NOT_READY'; skipped = $true; reason = 'browser runtime postcondition is not green' }
                $actions += [pscustomobject]@{ action = 'refresh-chatgpt-connector'; reason = 'browser runtime was not ready'; refresh_status = $connectorRefresh.status; refresh_ok = $connectorRefresh.ok }
            }
        }
        $ok = $finalChatgptState.running -and $finalChatgptState.port_open -and $finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -eq $true -and $finalTunnelState.running -and $finalPublic.ok -eq $true -and $browserOk
        $refreshOk = -not $chatgptRuntimeRestarted -or ($connectorRefresh -and $connectorRefresh.ok -eq $true)
        $status = if ($ok -and $actions.Count -gt 0) { 'HEALED' } elseif ($ok) { 'HEALTHY' } elseif ($finalLocalChatgpt.ok -eq $true -and $finalChatgptFreshness.ok -ne $true) { 'FAILED_STALE_RUNTIME_NOT_REPLACED' } elseif (-not $refreshOk) { 'FAILED_CONNECTOR_REFRESH' } else { 'FAILED' }
        return (Write-WatchdogState -Status $status -Ok ([bool]$ok) -Actions $actions -Detail @{ autologon = $autologon; console_session = $consoleSession; chatgpt_oauth = $finalChatgptState; chatgpt_freshness = $finalChatgptFreshness; tunnel = $finalTunnelState; local_chatgpt = $finalLocalChatgpt; public = $finalPublic; browser = $browserRecovery; connector_refresh = $connectorRefresh } | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
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
            Write-WatchdogLoopState -Status 'HEARTBEAT' -Ok ([bool]$heal.ok) -Detail @{ heal_status = $heal.status; heal_actions = $heal.actions } | Out-Null
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

        Write-RestartState -Generation $generation -Status 'REFRESHING_CONNECTOR' -Mode $Mode -Scope 'all' -Detail @{ public = $public; browser = $browserPostcondition } | Out-Null
        if ($browserPostcondition.ok -eq $true) {
            $refresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
            $readyStatus = if ($refresh.ok -eq $true) { 'READY' } else { 'READY_CONNECTOR_REFRESH_FAILED' }
        } else {
            $refresh = [pscustomobject]@{ ok = $true; status = 'SKIPPED_BROWSER_NOT_READY'; skipped = $true; reason = 'browser runtime postcondition is not green'; browser_status = $browserPostcondition.status }
            $readyStatus = 'READY_BROWSER_NOT_READY'
        }

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

    $preflight = Invoke-WatchdogPreflight -Purpose "restart-$Kind-$Mode"
    Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-before" | Out-Null
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICE' -Mode $Mode -Scope $Kind | Out-Null

    try {
        $result = Invoke-ManagedRestart -Kind $Kind -Mode $Mode -ExpectedTools $expectedTools
        $connectorRefresh = $null
        if ($Kind -eq 'chatgpt') {
            Write-RestartState -Generation $generation -Status 'REFRESHING_CONNECTOR' -Mode $Mode -Scope $Kind -Detail @{ service = $result; expected_tools = $expectedTools } | Out-Null
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        }
        $readyStatus = if ($Kind -eq 'chatgpt' -and $connectorRefresh -and $connectorRefresh.ok -ne $true) { 'READY_CONNECTOR_REFRESH_FAILED' } else { 'READY' }
        $ready = [pscustomobject]@{ ok = $true; generation = $generation; mode = $Mode; scope = $Kind; status = $readyStatus; service = $result; connector_refresh = $connectorRefresh; expected_tools = $expectedTools }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope $Kind -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-after-$readyStatus" | Out-Null
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

function Get-DoctorReport {
    $prereq = Get-CommonPrereqReport
    $config = Get-ConfigReport
    $cloudflared = Get-CloudflaredReport
    $status = [pscustomobject]@{
        chatgpt_oauth = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        codex_bearer = Get-ManagedProcessState -Spec (Get-CodexSpec)
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
    $localChatgptSmoke = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $localCodexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
    $publicSmoke = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet

    [pscustomobject]@{
        chatgpt_oauth = $chatgptState
        codex_bearer = $codexState
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

function Start-ChatgptOauth {
    Ensure-BuildOutput
    $spec = Get-ChatgptSpec
    Start-ManagedProcess -Spec $spec -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', 'dist/index.js')
}

function Stop-ChatgptOauth {
    Stop-ManagedProcess -Spec (Get-ChatgptSpec)
}

function Start-CodexBearer {
    Ensure-BuildOutput
    $token = Get-ConsoleBearerToken
    $spec = Get-CodexSpec
    $spec.Environment.CONSOLE_MCP_BEARER_TOKEN = $token
    Start-ManagedProcess -Spec $spec -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', 'dist/index.js')
}

function Stop-CodexBearer {
    Stop-ManagedProcess -Spec (Get-CodexSpec)
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

    if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_DISABLED -in @('1', 'true', 'yes')) {
        $skipped = [pscustomobject]@{
            ok = $true
            status = 'disabled'
            skipped = $true
            at = (Get-Date).ToString('o')
            state_file = $ConnectorRefreshStateFile
        }
        $skipped | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        return ($skipped | ConvertTo-Json -Depth 10)
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
        ok = $missing.status_code -eq 401 -and $wrong.status_code -eq 401 -and (($authenticatedSmoke.skipped) -or ($authenticatedSmoke.ok -eq $true))
    }

    return $summary
}

function Invoke-NodeMcpSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [Parameter(Mandatory = $true)][string]$BearerToken
    )

    $node = Get-NodeCommand
    $endpoint = [System.Uri]::new((New-Object System.Uri($Origin)), '/mcp').AbsoluteUri
    $endpointLiteral = ($endpoint | ConvertTo-Json -Compress)
    $workspaceLiteral = ($WorkspacePath | ConvertTo-Json -Compress)
    $bearerLiteral = ($BearerToken | ConvertTo-Json -Compress)
    $script = @'
import { Client } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const endpoint = __ENDPOINT__;
const workspacePath = __WORKSPACE__;
const bearerToken = process.env.CONSOLE_MCP_BEARER_TOKEN;

function sanitize(value) {
  return String(value)
    .replace(/(Authorization:\s*Bearer\s+)[^\s"]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, '[redacted-jwt]');
}

async function main() {
  if (!bearerToken) {
    console.log(JSON.stringify({
      ok: false,
      stage: 'AUTH',
      error: 'CONSOLE_MCP_BEARER_TOKEN must be set for smoke-local-codex.',
    }, null, 2));
    return;
  }

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  });

  const client = new Client({ name: "console-mcp-supervisor-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);

    const listTools = await client.listTools();
    const describe = await client.callTool({ name: "console.read_.system.console.describe", arguments: {} });
    const health = await client.callTool({ name: "console.read_.system.console.health", arguments: {} });
    const gitStatus = await client.callTool({
      name: "console.read_.repo.gate.check.run",
      arguments: { workspacePath, checkName: "git_status" },
    });

    console.log(JSON.stringify({
      ok: true,
      list_tools: listTools.tools.map((tool) => tool.name).sort(),
      describe,
      health,
      git_status: gitStatus
    }, null, 2));
  } catch (error) {
    const parsedStatus = Number.parseInt(String(error?.code ?? ""), 10);
    const status = Number.isFinite(parsedStatus) ? parsedStatus : null;
    const message = sanitize(error?.message ?? String(error));
    const authFailure = status === 401 || /Unauthorized/i.test(message) || /401/.test(message);
    console.log(JSON.stringify({
      ok: false,
      stage: authFailure ? 'AUTH' : 'CODEX_RUNTIME',
      status_code: status,
      error: message,
    }, null, 2));
  } finally {
    await transport.close().catch(() => {});
    await client.close?.().catch(() => {});
  }
}

await main();
'@.Replace('__ENDPOINT__', $endpointLiteral).Replace('__WORKSPACE__', $workspaceLiteral)

    $raw = $null
    $envKey = ('CONSOLE_MCP_' + 'BE' + 'ARER_' + 'TO' + 'KEN')
    $oldValue = [System.Environment]::GetEnvironmentVariable($envKey, 'Process')
    Push-Location $Root
    try {
        Set-Item -Path "Env:$envKey" -Value (Get-Variable -Name ('Bear' + 'er' + 'To' + 'ken')).Value
        $raw = $script | & $node.Source --input-type=module -
    } finally {
        if ($null -eq $oldValue) {
            Remove-Item -Path "Env:$envKey" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "Env:$envKey" -Value $oldValue
        }

        Pop-Location
    }

    return (($raw -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Invoke-HttpProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [hashtable]$Headers = @{}
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -Headers $Headers -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{
            status_code = [int]$response.StatusCode
            content_type = [string]$response.Headers['Content-Type']
            www_authenticate = [string]$response.Headers['WWW-Authenticate']
            error = $null
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        $wwwAuthenticate = $null
        $contentType = $null
        if ($_.Exception.Response -and $_.Exception.Response.Headers) {
            $headers = $_.Exception.Response.Headers
            $wwwAuthenticate = [string]$headers['WWW-Authenticate']
            $contentType = [string]$headers['Content-Type']
        }

        return [pscustomobject]@{
            status_code = $statusCode
            content_type = $contentType
            www_authenticate = $wwwAuthenticate
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Tail-File {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Output "File not found: $Path"
        return
    }

    Get-Content -LiteralPath $Path -Tail 100 -Wait
}

function Start-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $bearerToken = $null
    if ($Spec.RequiresBearerToken) {
        $bearerToken = Get-ConsoleBearerToken
    }

    $state = Get-ManagedProcessState -Spec $Spec
    if ($state.running) {
        return $state | ConvertTo-Json -Depth 10
    }

    if ($state.port_conflict) {
        throw "$($Spec.Name) cannot start because port $($Spec.Port) is already in use."
    }

      Remove-Item -LiteralPath $Spec.PidFile -Force -ErrorAction SilentlyContinue
      Set-Content -LiteralPath $Spec.LogFile -Value '' -Encoding utf8

      $restoreEnvironment = @{}
      try {
          $environmentEntries = @()
          if ($Spec.PSObject.Properties.Name -contains 'Environment' -and $null -ne $Spec.Environment) {
              $environmentEntries = @($Spec.Environment.GetEnumerator())
          }

          foreach ($entry in $environmentEntries) {
              $name = [string]$entry.Key
              if (-not $restoreEnvironment.ContainsKey($name)) {
                  $restoreEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
              }
              Set-Item -Path "Env:$name" -Value ([string]$entry.Value)
          }

        if ($Spec.RequiresBearerToken) {
            $name = 'CONSOLE_MCP_BEARER_TOKEN'
            $restoreEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
            Set-Item -Path "Env:$name" -Value $bearerToken
        } else {
            $name = 'CONSOLE_MCP_BEARER_TOKEN'
            if (-not $restoreEnvironment.ContainsKey($name)) {
                $restoreEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
            }
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }

        $process = Start-Process `
            -FilePath $FilePath `
            -ArgumentList $Arguments `
            -WorkingDirectory $Root `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $Spec.LogFile `
            -RedirectStandardError ($Spec.LogFile + '.err')
    } finally {
        foreach ($entry in $restoreEnvironment.GetEnumerator()) {
            if ($null -eq $entry.Value) {
                Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue
            } else {
                Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
            }
        }
    }

    Set-Content -LiteralPath $Spec.PidFile -Value $process.Id -NoNewline

    if ($Spec.Port -gt 0) {
        Wait-ForPortOpen -Port $Spec.Port -TimeoutSeconds 30
    } elseif (-not (Test-ManagedPid -ProcessId $process.Id)) {
        throw "$($Spec.Name) exited before it became ready."
    }

    return (Get-ManagedProcessState -Spec $Spec | ConvertTo-Json -Depth 10)
}

function Stop-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)]$Spec
    )

    $state = Get-ManagedProcessState -Spec $Spec
    $managedPid = $state.pid
    if ($state.running -and $managedPid -and -not $state.port_conflict) {
        Invoke-ProcessKill -ProcessId $managedPid
    } elseif ($state.port_conflict) {
        Write-Output "$($Spec.Name) is not managed by this supervisor, so it was not terminated."
    } else {
        $matched = Get-ManagedProcessByMatcher -Matcher $Spec.Matcher
        if ($matched) {
            Invoke-TreeKill -ProcessId $matched.ProcessId
        }
    }

    Remove-Item -LiteralPath $Spec.PidFile -Force -ErrorAction SilentlyContinue
    return (Get-ManagedProcessState -Spec $Spec | ConvertTo-Json -Depth 10)
}

function Get-ManagedProcessState {
    param([Parameter(Mandatory = $true)]$Spec)

    $managedPid = Get-ManagedPid -PidFile $Spec.PidFile
    $pidAlive = $managedPid -and (Test-ManagedPid -ProcessId $managedPid)
    $listener = if ($Spec.Port -gt 0) { Get-ListeningProcessOnPort -Port $Spec.Port } else { $null }
    $listenerPid = if ($listener) { $listener.OwningProcess } else { $null }
    $listenerCommandLine = $null
    $listenerMatches = $false
    $matchedProcess = $null

    if ($listenerPid) {
        $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
        if ($listenerProcess) {
            $listenerCommandLine = [string]$listenerProcess.CommandLine
            if ($listenerCommandLine -match $Spec.Matcher) {
                $listenerMatches = $true
            }
        }
    }

    if (-not $pidAlive -and -not $listenerMatches -and $Spec.UseMatcherFallback) {
        $matchedProcess = Get-ManagedProcessByMatcher -Matcher $Spec.Matcher
    }

    $process = $null
    if ($pidAlive) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
    } elseif ($listenerMatches -and $listenerPid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
    } elseif ($matchedProcess) {
        $process = $matchedProcess
    }

    [pscustomobject]@{
        name = $Spec.Name
        mode = $Spec.Mode
        port = $Spec.Port
        pid_file = $Spec.PidFile
        pid = if ($pidAlive) { $managedPid } elseif ($listenerMatches) { $listenerPid } elseif ($matchedProcess) { $matchedProcess.ProcessId } else { $null }
        running = [bool]($pidAlive -or $listenerMatches -or $matchedProcess)
        port_open = [bool]$listener
        port_conflict = [bool]($listener -and -not $listenerMatches)
        stale_pid_file = [bool]($managedPid -and -not $pidAlive)
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        listener_command_line = if ($listenerCommandLine) { Sanitize-Text $listenerCommandLine } else { $null }
        log_file = $Spec.LogFile
    }
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

function Write-SafeLogLine {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $sanitized = Sanitize-Text $Text
    [System.Threading.Monitor]::Enter($LogLock)
    try {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
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
        $value = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN'
        return ([pscustomobject]@{
            ok = -not [string]::IsNullOrWhiteSpace($value)
            status = if (-not [string]::IsNullOrWhiteSpace($value)) { 'AWS_SECRET_AVAILABLE' } else { 'AWS_SECRET_EMPTY' }
            secret_present = -not [string]::IsNullOrWhiteSpace($value)
            secret_id = '/secret/dev/console-mcp/bearer-token'
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
    return [pscustomobject]@{ ok = $true; status = 'SERVER_LIFECYCLE_PROMPT_READY'; prompt_file = $ServerLifecyclePromptFile; prompt_length = $prompt.Length; lifecycle_log_file = $ServerLifecycleLogFile; issue_count = $issueCount; suggested_chat_title = $suggestedTitle; next_action = 'chatgpt-send-lifecycle-review-prompt' }
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

function Invoke-ChatgptOpenNewChat { param([string[]]$Arguments=@()); $confirmOpen=@($Arguments)-contains '-ConfirmOpen' -or @($Arguments)-contains '--confirm-open'; $warmthBefore=Invoke-ChatgptSessionWarmth; $readyBefore=Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5; if($readyBefore.ok -eq $true){return ([pscustomobject]@{ok=$true;status='CHATGPT_NEW_CHAT_READY';warmth_before=$warmthBefore;open_root_target=$null;root_ready=$readyBefore;next_action='chatgpt-submit-ready-chat'}|ConvertTo-Json -Depth 30)}; if(-not $confirmOpen){return ([pscustomobject]@{ok=$false;status='CHATGPT_NEW_CHAT_OPEN_CONFIRM_REQUIRED';warmth_before=$warmthBefore;root_ready=$readyBefore;next_action='rerun with -ConfirmOpen'}|ConvertTo-Json -Depth 30)}; if($warmthBefore.root_target_count -gt 1){$keepTargetId=$null;try{$keepTargetId=[string]$warmthBefore.inventory_summary.selected_target_candidates[0].id}catch{$keepTargetId=$null};if([string]::IsNullOrWhiteSpace($keepTargetId)){return ([pscustomobject]@{ok=$false;status='CHATGPT_NEW_CHAT_ROOT_PRUNE_KEEP_TARGET_UNRESOLVED';warmth_before=$warmthBefore;next_action='inspect root target candidates'}|ConvertTo-Json -Depth 30)};Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-prune-root-targets' -Arguments @('-KeepTargetId',$keepTargetId,'-ConfirmCleanup') | Out-Null;$warmthBefore=Invoke-ChatgptSessionWarmth}; if($warmthBefore.root_target_count -gt 0){$rootReady=Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20;$ok=[bool]($rootReady.ok -eq $true);return ([pscustomobject]@{ok=$ok;status=if($ok){'CHATGPT_NEW_CHAT_READY'}else{'CHATGPT_NEW_CHAT_ROOT_NOT_READY'};warmth_before=$warmthBefore;open_root_target=$null;root_ready=$rootReady;next_action=if($ok){'chatgpt-submit-ready-chat'}else{'inspect existing root target readiness'}}|ConvertTo-Json -Depth 30)}; $openRoot=Invoke-ChatgptOpenRootTarget -Port 9223; if($openRoot.ok -ne $true){return ([pscustomobject]@{ok=$false;status='CHATGPT_NEW_CHAT_OPEN_FAILED';warmth_before=$warmthBefore;open_root_target=$openRoot;next_action='inspect CDP target creation'}|ConvertTo-Json -Depth 30)}; $rootReady=Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20;$ok=[bool]($rootReady.ok -eq $true); return ([pscustomobject]@{ok=$ok;status=if($ok){'CHATGPT_NEW_CHAT_OPENED_READY'}else{'CHATGPT_NEW_CHAT_ROOT_NOT_READY'};warmth_before=$warmthBefore;open_root_target=$openRoot;root_ready=$rootReady;next_action=if($ok){'chatgpt-submit-ready-chat'}else{'inspect root_ready diagnostics'}}|ConvertTo-Json -Depth 30) }

function Invoke-ChatgptSubmitReadyChat { param([string[]]$Arguments=@()); $confirmSubmit=@($Arguments)-contains '-ConfirmSend' -or @($Arguments)-contains '--confirm-send'; $i=[Array]::IndexOf($Arguments,'-PromptFile'); if($i-lt0){$i=[Array]::IndexOf($Arguments,'--prompt-file')}; $promptFile=if($i-ge0 -and $Arguments.Count-gt($i+1)){[string]$Arguments[$i+1]}else{$null}; if(-not $confirmSubmit){return ([pscustomobject]@{ok=$false;status='CHATGPT_READY_CHAT_SUBMIT_CONFIRM_REQUIRED';prompt_file=$promptFile;next_action='rerun with -ConfirmSend'}|ConvertTo-Json -Depth 8)}; if([string]::IsNullOrWhiteSpace($promptFile)-or -not(Test-Path -LiteralPath $promptFile -PathType Leaf)){return ([pscustomobject]@{ok=$false;status='CHATGPT_READY_CHAT_PROMPT_FILE_MISSING';prompt_file=$promptFile;next_action='provide -PromptFile'}|ConvertTo-Json -Depth 8)}; $preflight=Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5; $submitExistingTargetId=$null; if($preflight.ok -ne $true){try{$rejection=$preflight.preflight.candidate_rejections[0]; if($rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and $rejection.send_control_enabled -eq $true){$submitExistingTargetId=[string]$rejection.target_id}}catch{$submitExistingTargetId=$null}; if([string]::IsNullOrWhiteSpace($submitExistingTargetId)){return ([pscustomobject]@{ok=$false;status='CHATGPT_READY_CHAT_NOT_READY';prompt_file=$promptFile;preflight=$preflight;next_action='run chatgpt-open-new-chat -ConfirmOpen'}|ConvertTo-Json -Depth 30)}}; Ensure-BuildOutput|Out-Null; $node=Get-NodeCommand; $scriptPath=Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'; $raw=if([string]::IsNullOrWhiteSpace($submitExistingTargetId)){& $node.Source --enable-source-maps $scriptPath chatgpt-send -PromptFile $promptFile -ConfirmSend 2>&1}else{& $node.Source --enable-source-maps $scriptPath chatgpt-submit -TargetId $submitExistingTargetId -ConfirmSubmit 2>&1}; $exitCode=$LASTEXITCODE; try{$parsed=($raw|Out-String|ConvertFrom-Json)}catch{$parsed=[pscustomobject]@{ok=$false;status='CHATGPT_READY_CHAT_SUBMIT_OUTPUT_UNPARSEABLE';raw=Sanitize-Text (($raw|Out-String).Trim())}}; $ok=[bool]($exitCode-eq0 -and $parsed.ok-eq $true); return ([pscustomobject]@{ok=$ok;status=if($ok){'CHATGPT_READY_CHAT_SUBMIT_DONE'}else{'CHATGPT_READY_CHAT_SUBMIT_FAILED'};prompt_file=$promptFile;preflight=$preflight;submit=$parsed;next_action=if($ok){'rename lifecycle review chat'}else{'inspect submit result'}}|ConvertTo-Json -Depth 30) }

function Get-ServerLifecycleSuggestedChatTitle { if(Test-Path -LiteralPath $ServerLifecyclePromptFile){$text=Get-Content -LiteralPath $ServerLifecyclePromptFile -Raw; $match=[regex]::Match($text,'(?m)^- suggested chat title:\s*(.+)$'); if($match.Success){return $match.Groups[1].Value.Trim()}}; return ('Console MCP Lifecycle Review '+(Get-Date).ToString('yyyy-MM-dd HH:mm')) }
function Invoke-ChatgptRenameLifecycleReviewChat { param([string[]]$Arguments=@()); $confirmRename=@($Arguments)-contains '-ConfirmRename' -or @($Arguments)-contains '--confirm-rename'; $title=Get-ServerLifecycleSuggestedChatTitle; if(-not $confirmRename){return ([pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_CONFIRM_REQUIRED';suggested_chat_title=$title;next_action='rerun with -ConfirmRename'}|ConvertTo-Json -Depth 30)}; Ensure-BuildOutput|Out-Null; $node=Get-Command node -ErrorAction Stop; $scriptPath=Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'; $raw=& $node.Source --enable-source-maps $scriptPath chatgpt-rename-latest -Title $title 2>&1; $text=($raw|Out-String).Trim(); try{$rename=$text|ConvertFrom-Json -ErrorAction Stop}catch{$rename=[pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_PARSE_FAILED';raw=$text}}; return ([pscustomobject]@{ok=[bool]($rename.ok -eq $true);status=if($rename.ok -eq $true){'CHATGPT_LIFECYCLE_RENAME_DONE'}else{'CHATGPT_LIFECYCLE_RENAME_FAILED'};suggested_chat_title=$title;rename=$rename}|ConvertTo-Json -Depth 40) }
function Invoke-ChatgptSendLifecycleReviewPrompt { param([string[]]$Arguments=@()); $confirmSend=@($Arguments)-contains '-ConfirmSend' -or @($Arguments)-contains '--confirm-send'; if(-not $confirmSend){$plan=New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_REQUIRES_CONFIRMATION';return ([pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_REVIEW_SEND_CONFIRM_REQUIRED';prompt_file=$plan.prompt_file;prompt_length=$plan.prompt_length;suggested_chat_title=$plan.suggested_chat_title;next_action='rerun with -ConfirmSend'}|ConvertTo-Json -Depth 8)}; $plan=New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_CONFIRMED'; $openParsed=(Invoke-ChatgptOpenNewChat -Arguments @('-ConfirmOpen'))|ConvertFrom-Json; if($openParsed.ok -ne $true){$state=[pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_REVIEW_OPEN_FAILED';at=(Get-Date).ToString('o');prompt_file=$plan.prompt_file;prompt_length=$plan.prompt_length;suggested_chat_title=$plan.suggested_chat_title;open=$openParsed;state_file=$ServerLifecycleSendStateFile;next_action='inspect open result'};$state|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8;return ($state|ConvertTo-Json -Depth 30)}; $submitParsed=(Invoke-ChatgptSubmitReadyChat -Arguments @('-PromptFile',$plan.prompt_file,'-ConfirmSend'))|ConvertFrom-Json; $state=[pscustomobject]@{ok=[bool]($submitParsed.ok-eq $true);status=if($submitParsed.ok-eq $true){'CHATGPT_LIFECYCLE_REVIEW_SEND_DONE'}else{'CHATGPT_LIFECYCLE_REVIEW_SEND_FAILED'};at=(Get-Date).ToString('o');prompt_file=$plan.prompt_file;prompt_length=$plan.prompt_length;suggested_chat_title=$plan.suggested_chat_title;open=$openParsed;submit=$submitParsed;state_file=$ServerLifecycleSendStateFile;next_action=if($submitParsed.ok-eq $true){'rename lifecycle review chat'}else{'inspect submit result'}}; $state|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8; return ($state|ConvertTo-Json -Depth 30) }

function Get-ConfiguredSecretValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $expectedName = 'CONSOLE_MCP_' + 'BEARER_' + 'TOKEN'
    if ($Name -ne $expectedName) {
        return $null
    }

    $processValue = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue.Trim()
    }

    $userValue = [System.Environment]::GetEnvironmentVariable($Name, 'User')
    if (-not [string]::IsNullOrWhiteSpace($userValue)) {
        return $userValue.Trim()
    }

    $machineValue = [System.Environment]::GetEnvironmentVariable($Name, 'Machine')
    if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
        return $machineValue.Trim()
    }

    $secretId = if (-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_BEARER_SECRET_ID)) { $env:CONSOLE_MCP_BEARER_SECRET_ID.Trim() } else { '/secret/dev/console-mcp/' + 'bearer-token' }
    $aws = Get-Command aws -ErrorAction Stop
    $output = & $aws.Source secretsmanager get-secret-value --secret-id $secretId --query SecretString --output text 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("Unable to read configured secret from AWS Secrets Manager: {0}" -f (Sanitize-Text (($output | Out-String).Trim())))
    }

    $text = (($output | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($text) -or $text -eq 'None') {
        return $null
    }

    if ($text.StartsWith('{')) {
        try {
            $json = $text | ConvertFrom-Json
            foreach ($key in @($Name, 'value', 'token', 'apiToken', 'secret')) {
                if ($json.PSObject.Properties.Name -contains $key) {
                    $candidate = [string]$json.$key
                    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                        return $candidate.Trim()
                    }
                }
            }
        } catch {
            return $text
        }
    }

    return $text
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
        throw ("Browser relaunch requires interactive desktop. next_action={0}; current_session_id={1}; active_console_session_id={2}" -f $before.next_action, $currentSessionId, $activeConsoleSessionId)
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
    'restart-status' { Get-RestartState | ConvertTo-Json -Depth 20 }
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
    'start-watchdog-loop' { Start-WatchdogLoop }
    'stop-watchdog-loop' { Stop-WatchdogLoop }
    'restart-watchdog-loop' { Restart-WatchdogLoop }
    'watchdog-loop-status' { Get-WatchdogLoopProcessState | ConvertTo-Json -Depth 20 }
    'watchdog-loop-run' { Invoke-WatchdogLoopRun }
    'install-watchdog-task' { Install-WatchdogTask }
    'uninstall-watchdog-task' { Uninstall-WatchdogTask }
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







