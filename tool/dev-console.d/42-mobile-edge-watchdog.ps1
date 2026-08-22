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
