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

