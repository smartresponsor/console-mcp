function Get-EdgeDevtoolsProcess {
    param([int]$Port = 9223)

    $pattern = "--remote-debugging-port=$Port"
    return @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -like "*$pattern*"
    })
}

function Stop-EdgeDevtoolsProcess {
    param([int]$Port = 9223)

    $processes = @(Get-EdgeDevtoolsProcess -Port $Port)
    $stopped = @()
    foreach ($process in $processes) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            $stopped += [pscustomobject]@{
                pid = $process.ProcessId
                session_id = $process.SessionId
                stopped = $true
            }
        } catch {
            $stopped += [pscustomobject]@{
                pid = $process.ProcessId
                session_id = $process.SessionId
                stopped = $false
                error = Sanitize-Text $_.Exception.Message
            }
        }
    }

    return [pscustomobject]@{
        ok = @($stopped | Where-Object { -not $_.stopped }).Count -eq 0
        port = $Port
        matched_count = $processes.Count
        stopped = $stopped
    }
}

function Invoke-BrowserRelaunchVisible {
    param([string]$Purpose = 'manual')

    $before = Get-BrowserStackHealthReport
    $stop = Stop-EdgeDevtoolsProcess -Port 9223
    Start-Sleep -Seconds 1
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
        stop = $stop
        started = $started
        after = $after
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "browser-relaunch-$Purpose") -Payload $result | Out-Null
