[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
        'status',
        'start-server',
        'stop-server',
        'restart-server',
        'start-tunnel',
        'stop-tunnel',
        'restart-tunnel',
        'restart-all',
        'smoke-local',
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
$ServerPidFile = Join-Path $RunDir 'console-mcp.pid'
$TunnelPidFile = Join-Path $RunDir 'cloudflared-console-mcp.pid'
$ServerLogFile = Join-Path $LogDir 'console-mcp.log'
$TunnelLogFile = Join-Path $LogDir 'cloudflared-console-mcp.log'
$HttpTraceFile = Join-Path $TranscriptDir 'http-trace.ndjson'
$OAuthDebugFile = Join-Path $TranscriptDir 'oauth-debug.ndjson'
$LocalOrigin = 'http://127.0.0.1:3333'
$PublicOrigin = 'https://console-mcp.smartresponsor.com'
$OAuthIssuer = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/'
$OAuthAudience = 'https://console-mcp.smartresponsor.com'
$OAuthScope = 'console:read'
$OAuthJwksUri = 'https://dev-zdyugcgamq4bca8f.us.auth0.com/.well-known/jwks.json'
$CloudflaredExe = Join-Path $env:TEMP 'cloudflared.exe'
$CloudflaredConfig = Join-Path $HOME '.cloudflared\console-mcp.yml'
$ServerHost = '127.0.0.1'
$ServerPort = 3333
$LogLock = [object]::new()

Ensure-Directories

switch ($Command) {
    'status' { Show-Status }
    'start-server' { Start-Server }
    'stop-server' { Stop-Server }
    'restart-server' {
        Stop-Server
        Start-Server
    }
    'start-tunnel' { Start-Tunnel }
    'stop-tunnel' { Stop-Tunnel }
    'restart-tunnel' {
        Stop-Tunnel
        Start-Tunnel
    }
    'restart-all' {
        Stop-Tunnel
        Stop-Server
        Start-Server
        Start-Tunnel
    }
    'smoke-local' { Invoke-Smoke -Origin $LocalOrigin -Label 'local' }
    'smoke-public' { Invoke-Smoke -Origin $PublicOrigin -Label 'public' }
    'tail-http-trace' { Tail-File -Path $HttpTraceFile }
    'tail-oauth-debug' { Tail-File -Path $OAuthDebugFile }
    'tail-server-log' { Tail-File -Path $ServerLogFile }
    'tail-tunnel-log' { Tail-File -Path $TunnelLogFile }
}

function Ensure-Directories {
    foreach ($path in @($RunDir, $LogDir, $TranscriptDir)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Show-Status {
    $serverState = Get-ManagedProcessState -PidFile $ServerPidFile -Port $ServerPort -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start'
    $tunnelState = Get-ManagedProcessState -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp'
    $localSmoke = Invoke-Smoke -Origin $LocalOrigin -Label 'local' -Quiet
    $publicSmoke = Invoke-Smoke -Origin $PublicOrigin -Label 'public' -Quiet

    [pscustomobject]@{
        server = $serverState
        tunnel = $tunnelState
        smoke = [pscustomobject]@{
            local = $localSmoke
            public = $publicSmoke
        }
    } | ConvertTo-Json -Depth 8
}

function Start-Server {
    $npm = Get-Command npm -ErrorAction Stop
    $envMap = @{
        CONSOLE_MCP_AUTH_MODE = 'oauth'
        CONSOLE_MCP_PUBLIC_ORIGIN = $PublicOrigin
        CONSOLE_MCP_OAUTH_ISSUER = $OAuthIssuer
        CONSOLE_MCP_OAUTH_AUDIENCE = $OAuthAudience
        CONSOLE_MCP_OAUTH_REQUIRED_SCOPE = $OAuthScope
        CONSOLE_MCP_OAUTH_JWKS_URI = $OAuthJwksUri
        CONSOLE_MCP_OAUTH_DEBUG = '1'
        CONSOLE_MCP_TRACE = '1'
        CONSOLE_MCP_HOST = $ServerHost
        CONSOLE_MCP_PORT = $ServerPort.ToString()
    }

    if (Test-ManagedProcessLive -PidFile $ServerPidFile -Port $ServerPort -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start') {
        Write-Output (Get-ManagedProcessState -PidFile $ServerPidFile -Port $ServerPort -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start' | ConvertTo-Json -Depth 6)
        return
    }

    Start-ManagedProcess `
        -Name 'console-mcp' `
        -FilePath $npm.Source `
        -Arguments @('run', 'start') `
        -WorkingDirectory $Root `
        -Environment $envMap `
        -PidFile $ServerPidFile `
        -LogFile $ServerLogFile

    Write-Output (Get-ManagedProcessState -PidFile $ServerPidFile -Port $ServerPort -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start' | ConvertTo-Json -Depth 6)
}

function Stop-Server {
    Stop-ManagedProcess -PidFile $ServerPidFile -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start'
    Write-Output (Get-ManagedProcessState -PidFile $ServerPidFile -Port $ServerPort -Matcher 'dist[\\/]+index\.js|npm\s+run\s+start' | ConvertTo-Json -Depth 6)
}

function Start-Tunnel {
    if (-not (Test-Path -LiteralPath $CloudflaredExe)) {
        throw "cloudflared not found at $CloudflaredExe."
    }
    if (-not (Test-Path -LiteralPath $CloudflaredConfig)) {
        throw "cloudflared config not found at $CloudflaredConfig."
    }

    if (Test-ManagedProcessLive -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp') {
        Write-Output (Get-ManagedProcessState -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp' | ConvertTo-Json -Depth 6)
        return
    }

    Start-ManagedProcess `
        -Name 'cloudflared-console-mcp' `
        -FilePath $CloudflaredExe `
        -Arguments @('tunnel', '--config', $CloudflaredConfig, 'run', 'console-mcp') `
        -WorkingDirectory $Root `
        -Environment @{} `
        -PidFile $TunnelPidFile `
        -LogFile $TunnelLogFile

    Write-Output (Get-ManagedProcessState -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp' | ConvertTo-Json -Depth 6)
}

function Stop-Tunnel {
    Stop-ManagedProcess -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp'
    Write-Output (Get-ManagedProcessState -PidFile $TunnelPidFile -Matcher 'cloudflared.*run\s+console-mcp' | ConvertTo-Json -Depth 6)
}

function Invoke-Smoke {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Origin,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [switch]$Quiet
    )

    $metadata = Invoke-SafeGet -Url "$Origin/.well-known/oauth-protected-resource"
    $mcp = Invoke-SafeGet -Url "$Origin/mcp"
    $summary = [pscustomobject]@{
        label = $Label
        metadata_status = $metadata.status_code
        metadata_www_authenticate = $metadata.www_authenticate
        mcp_status = $mcp.status_code
        mcp_www_authenticate = $mcp.www_authenticate
        metadata_ok = $metadata.status_code -eq 200
        mcp_unauthorized = $mcp.status_code -eq 401 -and [string]::IsNullOrWhiteSpace($mcp.www_authenticate) -eq $false
    }

    if (-not $Quiet) {
        $summary | ConvertTo-Json -Depth 6
    }

    return $summary
}

function Invoke-SafeGet {
    param([Parameter(Mandatory = $true)][string]$Url)

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -SkipHttpErrorCheck -TimeoutSec 10 -ErrorAction Stop
        return [pscustomobject]@{
            status_code = [int]$response.StatusCode
            www_authenticate = [string]$response.Headers['WWW-Authenticate']
            content_type = [string]$response.Headers['Content-Type']
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            status_code = $null
            www_authenticate = $null
            content_type = $null
            error = Sanitize-Text ($_.Exception.Message)
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
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    foreach ($argument in $Arguments) {
        [void]$psi.ArgumentList.Add($argument)
    }
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    foreach ($entry in $Environment.GetEnumerator()) {
        $psi.Environment[$entry.Key] = [string]$entry.Value
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi

    $handler = {
        param($sender, $eventArgs)
        if ($null -ne $eventArgs.Data -and $eventArgs.Data -ne '') {
            Write-SafeLogLine -Path $LogFile -Text $eventArgs.Data
        }
    }

    $null = $process.add_OutputDataReceived($handler)
    $null = $process.add_ErrorDataReceived($handler)

    if (-not $process.Start()) {
        throw "Failed to start $Name."
    }

    Set-Content -LiteralPath $PidFile -Value $process.Id -NoNewline
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
    Start-Sleep -Milliseconds 250
}

function Stop-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$Matcher
    )

    $pid = Get-ManagedPid -PidFile $PidFile
    if ($pid -and (Test-ManagedPid -Pid $pid)) {
        Invoke-TreeKill -Pid $pid
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        return
    }

    $process = Get-ManagedProcessByMatcher -Matcher $Matcher
    if ($process) {
        Invoke-TreeKill -Pid $process.ProcessId
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Invoke-TreeKill {
    param([Parameter(Mandatory = $true)][int]$Pid)

    $taskkill = Get-Command taskkill.exe -ErrorAction Stop
    & $taskkill.Source /PID $Pid /T /F | Out-Null
}

function Get-ManagedProcessState {
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [int]$Port = 0,
        [string]$Matcher = ''
    )

    $pid = Get-ManagedPid -PidFile $PidFile
    $pidAlive = $pid -and (Test-ManagedPid -Pid $pid)
    $matchedProcess = if ($Matcher) { Get-ManagedProcessByMatcher -Matcher $Matcher } else { $null }
    $portOpen = if ($Port -gt 0) { Test-PortOpen -Port $Port } else { $false }
    $process = if ($matchedProcess) { $matchedProcess } elseif ($pidAlive) { Get-CimInstance Win32_Process -Filter "ProcessId = $pid" } else { $null }

    [pscustomobject]@{
        pid_file = $PidFile
        pid = if ($pidAlive) { $pid } else { $null }
        running = [bool]($pidAlive -or $matchedProcess -or $portOpen)
        port_open = $portOpen
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        stale_pid_file = [bool]($pid -and -not $pidAlive)
    }
}

function Get-ManagedPid {
    param([Parameter(Mandatory = $true)][string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile)) {
        return $null
    }

    $text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if (-not [int]::TryParse($text, [ref]$parsed)) {
        return $null
    }

    return $parsed
}

function Test-ManagedPid {
    param([Parameter(Mandatory = $true)][int]$Pid)

    try {
        Get-Process -Id $Pid -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-ManagedProcessByMatcher {
    param([Parameter(Mandatory = $true)][string]$Matcher)

    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $Matcher } |
        Select-Object -First 1
}

function Test-PortOpen {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1') } |
        Select-Object -First 1
    return [bool]$connection
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

function Sanitize-Text {
    param([Parameter(Mandatory = $true)][string]$Text)

    $value = $Text
    $value = $value -replace '(?i)(Authorization:\s*Bearer\s+)[^\s"]+', '$1[redacted]'
    $value = $value -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+\b', 'Bearer [redacted]'
    $value = $value -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+', '[redacted-jwt]'
    $value = $value -replace '(?i)\b(client_secret|authorization_code|refresh_token|access_token)\b\s*[:=]\s*[^,\s"]+', '$1=[redacted]'
    return $value
}
