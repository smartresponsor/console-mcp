function Get-InteractiveConsoleSessionReport { try { $raw = (query user 2>&1 | Out-String).Trim(); return [pscustomobject]@{ raw = Sanitize-Text $raw; has_active_console = [bool]($raw -match 'console' -and $raw -match '(Active|Активно)') } } catch { return [pscustomobject]@{ raw = Sanitize-Text $_.Exception.Message; has_active_console = $false } } }
function Get-BrowserStackHealthReport {
    $markerFile = Join-Path (Split-Path -Parent $Root) 'browser\log\startup-edge-marker.txt'
    $marker = if (Test-Path -LiteralPath $markerFile -PathType Leaf) { Sanitize-Text ((Get-Content -LiteralPath $markerFile -Raw).Trim()) } else { $null }
    $consoleSession = Get-InteractiveConsoleSessionReport
    $edge = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 })
    $cdp = $null
    $cdpError = $null
    $cdpOk = $false
    try {
        $cdp = Invoke-RestMethod 'http://127.0.0.1:9223/json/version' -TimeoutSec 3
        $cdpOk = [bool]($cdp.Browser -match '^Edg/')
    } catch {
        $cdpError = Sanitize-Text $_.Exception.Message
    }
    $ok = [bool]($marker -and $consoleSession.has_active_console -and $edge.Count -gt 0 -and $cdpOk)
    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'GREEN' } else { 'RED' }
        marker_file = $markerFile
        marker = $marker
        active_console = $consoleSession
        microsoft_edge = [pscustomobject]@{
            interactive_process_count = $edge.Count
            session_ids = @($edge | Select-Object -ExpandProperty SessionId -Unique | Sort-Object)
        }
        cdp_9223 = [pscustomobject]@{
            ok = $cdpOk
            browser = if ($cdp) { $cdp.Browser } else { $null }
            error = $cdpError
        }
        gate = 'marker + active console session + Microsoft Edge SessionId > 0 + CDP 9223 ok'
    }
}

Set-Variable -Name DevConsoleBrowserHealthModuleLoaded -Scope Script -Value $true -Force
