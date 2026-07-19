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
