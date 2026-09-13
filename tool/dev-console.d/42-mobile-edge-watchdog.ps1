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
        $ownerPid = [int]$connection.OwningProcess
        if ($ownerPid -le 0) { continue }
        try {
            Stop-Process -Id $ownerPid -Force -ErrorAction Stop
            $stopped += [pscustomobject]@{ pid = $ownerPid; stopped = $true }
        } catch {
            $stopped += [pscustomobject]@{ pid = $ownerPid; stopped = $false; error = Sanitize-Text $_.Exception.Message }
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
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $stdoutLog = Join-Path $MobileEdgeLogDir "$stamp-stdout.log"
    $stderrLog = Join-Path $MobileEdgeLogDir "$stamp-stderr.log"
    $previousPort = $env:PORT
    try {
        $env:PORT = [string]$MobileEdgePort
        $process = Start-Process -FilePath $npm -ArgumentList @('run', 'dev') -WorkingDirectory $MobileEdgeWorkspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    } finally {
        if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
    }
    $stateDir = Join-Path $MobileEdgeWorkspacePath '.console-mcp'
    $stateFile = Join-Path $stateDir 'mobile-edge-server.json'
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    [ordered]@{
        packageName = 'mobile-edge'
        pid = $process.Id
        port = $MobileEdgePort
        script = 'dev'
        cwd = $MobileEdgeWorkspacePath
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        healthUrl = $MobileEdgeHealthUrl
        stdoutLog = $stdoutLog
        stderrLog = $stderrLog
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding utf8
    return [pscustomobject]@{ pid = $process.Id; workspace = $MobileEdgeWorkspacePath; port = $MobileEdgePort; stdout_log = $stdoutLog; stderr_log = $stderrLog; state_file = $stateFile; command = 'npm run dev' }
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

function Get-VisualGalleryBindHost {
    try {
        $candidate = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' } |
            Sort-Object @{ Expression = { if ([string]$_.InterfaceAlias -match 'Tailscale') { 0 } else { 1 } } }, InterfaceMetric |
            Select-Object -First 1
        if ($candidate -and -not [string]::IsNullOrWhiteSpace([string]$candidate.IPAddress)) {
            return [pscustomobject]@{ host = [string]$candidate.IPAddress; mode = 'tailscale'; interface_alias = [string]$candidate.InterfaceAlias }
        }
    } catch {}
    return [pscustomobject]@{ host = '127.0.0.1'; mode = 'loopback_fallback'; interface_alias = $null }
}

function Invoke-VisualGalleryHealthProbe {
    $bind = Get-VisualGalleryBindHost
    $url = "http://$($bind.host):$VisualGalleryPort/health"
    try {
        $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 3 -SkipHttpErrorCheck -ErrorAction Stop
        $ok = [bool]($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
        return [pscustomobject]@{ ok = $ok; status = if ($ok) { 'VISUAL_GALLERY_HEALTHY' } else { 'VISUAL_GALLERY_UNHEALTHY_STATUS' }; url = $url; gallery_url = "http://$($bind.host):$VisualGalleryPort/"; host = $bind.host; bind_mode = $bind.mode; interface_alias = $bind.interface_alias; status_code = [int]$response.StatusCode; artifact_root = $VisualGalleryArtifactRoot; state_file = $VisualGalleryStateFile; error = $null }
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'VISUAL_GALLERY_UNREACHABLE'; url = $url; gallery_url = "http://$($bind.host):$VisualGalleryPort/"; host = $bind.host; bind_mode = $bind.mode; interface_alias = $bind.interface_alias; status_code = $null; artifact_root = $VisualGalleryArtifactRoot; state_file = $VisualGalleryStateFile; error = Sanitize-Text $_.Exception.Message }
    }
}

function Stop-VisualGalleryManagedProcess {
    if (-not (Test-Path -LiteralPath $VisualGalleryStateFile -PathType Leaf)) { return @() }
    try { $state = Get-Content -LiteralPath $VisualGalleryStateFile -Raw | ConvertFrom-Json -Depth 10 } catch { return @() }
    if (-not $state -or -not $state.pid) { return @() }
    $stopped = @()
    try {
        $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $stopped += [pscustomobject]@{ pid = $process.Id; stopped = $true }
    } catch {
        $stopped += [pscustomobject]@{ pid = [int]$state.pid; stopped = $false; error = Sanitize-Text $_.Exception.Message }
    }
    Remove-Item -LiteralPath $VisualGalleryStateFile -Force -ErrorAction SilentlyContinue
    return @($stopped)
}

function Start-VisualGalleryServer {
    if (-not (Test-Path -LiteralPath $VisualGalleryScriptPath -PathType Leaf)) { throw "Visual gallery script is missing: $VisualGalleryScriptPath" }
    New-Item -ItemType Directory -Force -Path $VisualGalleryArtifactRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $VisualGalleryStateFile) | Out-Null
    New-Item -ItemType Directory -Force -Path $VisualGalleryLogDir | Out-Null
    $bind = Get-VisualGalleryBindHost
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $stdoutLog = Join-Path $VisualGalleryLogDir "$stamp-stdout.log"
    $stderrLog = Join-Path $VisualGalleryLogDir "$stamp-stderr.log"
    $node = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $node -ArgumentList @($VisualGalleryScriptPath, '--root', $VisualGalleryArtifactRoot, '--host', $bind.host, '--port', [string]$VisualGalleryPort) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $state = [ordered]@{ tool = 'visual-gallery-server'; pid = $process.Id; host = $bind.host; port = $VisualGalleryPort; artifactRoot = $VisualGalleryArtifactRoot; scriptPath = $VisualGalleryScriptPath; startedAt = (Get-Date).ToUniversalTime().ToString('o'); healthUrl = "http://$($bind.host):$VisualGalleryPort/health"; galleryUrl = "http://$($bind.host):$VisualGalleryPort/"; stdoutLog = $stdoutLog; stderrLog = $stderrLog; bindMode = $bind.mode; interfaceAlias = $bind.interface_alias }
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $VisualGalleryStateFile -Encoding utf8
    return [pscustomobject]$state
}

function Invoke-VisualGalleryWatchdogHeal {
    $before = Invoke-VisualGalleryHealthProbe
    if ($before.ok -eq $true) {
        return [pscustomobject]@{ ok = $true; status = 'VISUAL_GALLERY_HEALTHY'; action_taken = 'none'; before = $before; after = $before; start = $null; stopped = @() }
    }
    $stopped = Stop-VisualGalleryManagedProcess
    $start = Start-VisualGalleryServer
    $after = $null
    foreach ($attempt in 1..20) {
        Start-Sleep -Milliseconds 300
        $after = Invoke-VisualGalleryHealthProbe
        if ($after.ok -eq $true) { break }
    }
    return [pscustomobject]@{ ok = [bool]($after -and $after.ok -eq $true); status = if ($after -and $after.ok -eq $true) { 'VISUAL_GALLERY_HEALED' } else { 'VISUAL_GALLERY_FAILED' }; action_taken = 'restart'; before = $before; stopped = @($stopped); start = $start; after = $after }
}
