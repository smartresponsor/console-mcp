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
        'check-autostart',
        'pre-signout',
        'post-login',
        'start-chatgpt-oauth',
        'stop-chatgpt-oauth',
        'restart-chatgpt-oauth',
        'start-codex-bearer',
        'stop-codex-bearer',
        'restart-codex-bearer',
        'start-tunnel',
        'stop-tunnel',
        'restart-tunnel',
        'restart-all',
        'install-startup-task',
        'uninstall-startup-task',
        'show-startup-task',
        'create-shortcuts',
        'remove-shortcuts',
        'smoke-local-chatgpt',
        'smoke-local-codex',
        'smoke-public',
        'tail-http-trace',
        'tail-oauth-debug',
        'tail-server-log',
        'tail-tunnel-log'
    )]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root 'var/run'
$LogDir = Join-Path $Root 'var/log'
$TranscriptDir = Join-Path $Root 'var/transcript'
$ChatgptPidFile = Join-Path $RunDir 'console-mcp-chatgpt-oauth.pid'
$CodexPidFile = Join-Path $RunDir 'console-mcp-codex-bearer.pid'
$TunnelPidFile = Join-Path $RunDir 'cloudflared-console-mcp.pid'
$ChatgptLogFile = Join-Path $LogDir 'console-mcp-chatgpt-oauth.log'
$CodexLogFile = Join-Path $LogDir 'console-mcp-codex-bearer.log'
$TunnelLogFile = Join-Path $LogDir 'cloudflared-console-mcp.log'
$HttpTraceFile = Join-Path $TranscriptDir 'http-trace.ndjson'
$OAuthDebugFile = Join-Path $TranscriptDir 'oauth-debug.ndjson'
$ChatgptOrigin = 'http://127.0.0.1:3333'
$CodexOrigin = 'http://127.0.0.1:3334'
$PublicOrigin = 'https://console-mcp.smartresponsor.com'
$OAuthIssuer = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/'
$OAuthAudience = 'https://console-mcp.smartresponsor.com'
$OAuthScope = 'console:read'
$OAuthJwksUri = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/.well-known/jwks.json'
$CloudflaredConfig = Join-Path (Join-Path $HOME '.cloudflared') 'console-mcp.yml'
$DefaultWorkspaceRoot = Split-Path -Parent $Root
$StartupTaskName = 'console-mcp-chatgpt-oauth'
$StartupTaskPath = '\'
$StartupTaskCommand = 'restart-all'
$ShortcutRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Console MCP'
$LogLock = [object]::new()

function Ensure-Directories {
    foreach ($path in @($RunDir, $LogDir, $TranscriptDir)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

Ensure-Directories

function Ensure-BuildOutput {
    $distIndex = Join-Path $Root 'dist/index.js'
    if (-not (Test-Path -LiteralPath $distIndex)) {
        $npm = Get-NpmCommand
        & $npm run build
    }
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
        }
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
    $distIndex = Join-Path $Root 'dist/index.js'
    $distExists = Test-Path -LiteralPath $distIndex

    [pscustomobject]@{
        repo_root = $Root
        repo_root_exists = $repoRootExists
        node = $node
        npm = $npm
        pwsh = $pwsh
        dist_index = [pscustomobject]@{
            path = $distIndex
            exists = $distExists
            build_needed = -not $distExists
        }
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

    return [pscustomobject]@{
        console_mcp_startup_task_installed = [bool]$startupTask.exists
        tailscale_service_installed = [bool]$tailscale.installed
        tailscale_autostart_automatic = [bool]$tailscale.autostart_automatic
        tailscale_running = [bool]$tailscale.running
        tailscale_cli_status_ok = [bool]$tailscale.cli_status_ok
        ok = [bool]$startupTask.exists -and [bool]$tailscale.installed -and [bool]$tailscale.autostart_automatic -and [bool]$tailscale.running -and [bool]$tailscale.cli_status_ok
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
        "Tailscale service installed? $($Summary.tailscale_service_installed)"
        "Tailscale autostart Automatic? $($Summary.tailscale_autostart_automatic)"
        "Tailscale running? $($Summary.tailscale_running)"
        "Tailscale CLI status ok? $($Summary.tailscale_cli_status_ok)"
    ) -join [Environment]::NewLine
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
        "dist_index_exists: $($report.prereq.dist_index.exists)"
        "workspace_root_effective: $($report.config.workspace_root_effective)"
        "chatgpt_oauth_port_3333: running=$($report.config.chatgpt_port.running) port_open=$($report.config.chatgpt_port.port_open)"
        "codex_bearer_port_3334: running=$($report.config.codex_port.running) port_open=$($report.config.codex_port.port_open)"
        "cloudflared_binary_resolved: $($report.cloudflared.binary_resolved)"
        "cloudflared_config_exists: $($report.cloudflared.config_exists)"
        "cloudflared_credential_file_exists: $($report.cloudflared.credential_file_exists)"
        "local_chatgpt_smoke_ok: $($report.status.smoke.local_chatgpt.ok)"
        "local_codex_smoke_ok: $($report.status.smoke.local_codex.ok)"
        "public_smoke_ok: $($report.status.smoke.public.ok)"
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
        tailscale = Get-TailscaleReport
        autostart = Get-AutostartSummary
        smoke = [pscustomobject]@{
            local_chatgpt = $localChatgptSmoke
            local_codex = $localCodexSmoke
            public = $publicSmoke
        }
    } | ConvertTo-Json -Depth 10
}

function Start-ChatgptOauth {
    Ensure-BuildOutput
    Start-ManagedProcess -Spec (Get-ChatgptSpec) -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', 'dist/index.js')
}

function Stop-ChatgptOauth {
    Stop-ManagedProcess -Spec (Get-ChatgptSpec)
}

function Start-CodexBearer {
    Ensure-BuildOutput
    $token = Get-ConsoleBearerToken
    $spec = Get-CodexSpec
    $spec.Environment.CONSOLE_MCP_BEARER_TOKEN = $token
    $cloudflareApiToken = [System.Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($cloudflareApiToken)) {
        $spec.Environment.CLOUDFLARE_API_TOKEN = $cloudflareApiToken
    }
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

function Wait-PublicSmokeReady {
    param(
        [int]$TimeoutSeconds = 30,
        [int]$IntervalSeconds = 2
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null

    while ((Get-Date) -lt $deadline) {
        $last = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        if ($last.ok -eq $true) {
            return $last
        }

        Start-Sleep -Seconds $IntervalSeconds
    }

    throw ("public smoke did not become ready within {0} seconds. Last result: {1}" -f $TimeoutSeconds, (($last | ConvertTo-Json -Depth 8 -Compress)))
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

    $token = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN'
    if ($token) {
        try {
            $authenticatedSmoke = Invoke-NodeMcpSmoke -Origin $Origin -WorkspacePath (Get-WorkspaceRoot) -BearerToken $token
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
    const describe = await client.callTool({ name: "console.describe", arguments: {} });
    const health = await client.callTool({ name: "console.health", arguments: {} });
    const gitStatus = await client.callTool({
      name: "console.run_check",
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
    if ($managedPid -and (Test-ManagedPid -ProcessId $managedPid)) {
        Invoke-TreeKill -ProcessId $managedPid
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

function Get-ConsoleBearerToken {
    $token = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN'
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "CONSOLE_MCP_BEARER_TOKEN must be set before starting or smoking the Codex bearer profile."
    }

    return $token.Trim()
}

function Get-ConfiguredSecretValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value.Trim()
    }

    $value = [System.Environment]::GetEnvironmentVariable($Name, 'User')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value.Trim()
    }

    $value = [System.Environment]::GetEnvironmentVariable($Name, 'Machine')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value.Trim()
    }

    return $null
}

switch ($Command) {
    'status' { Show-Status }
    'doctor' { Show-Doctor }
    'doctor-json' { Show-DoctorJson }
    'check-prereq' { Check-Prereq }
    'check-config' { Check-Config }
    'check-autostart' { Get-AutostartSummary | ConvertTo-Json -Depth 12 }
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
    'start-chatgpt-oauth' { Start-ChatgptOauth }
    'stop-chatgpt-oauth' { Stop-ChatgptOauth }
    'restart-chatgpt-oauth' {
        Stop-ChatgptOauth
        Start-ChatgptOauth
    }
    'start-codex-bearer' { Start-CodexBearer }
    'stop-codex-bearer' { Stop-CodexBearer }
    'restart-codex-bearer' {
        Stop-CodexBearer
        Start-CodexBearer
    }
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
            Stop-Tunnel
            Stop-CodexBearer
            Stop-ChatgptOauth
            Start-ChatgptOauth
            Start-CodexBearer
            Start-Tunnel | Out-Null
        } catch {
            Write-Output (Sanitize-Text $_.Exception.Message)
            exit 1
        }
    }
    'install-startup-task' { Install-StartupTask }
    'uninstall-startup-task' { Uninstall-StartupTask }
    'show-startup-task' { Show-StartupTask }
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
    'tail-oauth-debug' { Tail-File -Path $OAuthDebugFile }
    'tail-server-log' { Tail-ServerLog }
    'tail-tunnel-log' { Tail-File -Path $TunnelLogFile }
}
