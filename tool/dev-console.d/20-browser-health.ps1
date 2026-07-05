function Get-InteractiveConsoleSessionReport { try { $raw = (query user 2>&1 | Out-String).Trim(); return [pscustomobject]@{ raw = Sanitize-Text $raw; has_active_console = [bool]($raw -match 'console' -and $raw -match '(Active|Активно)') } } catch { return [pscustomobject]@{ raw = Sanitize-Text $_.Exception.Message; has_active_console = $false } } }
function Get-BrowserStackHealthReport {
    $markerFile = Join-Path (Split-Path -Parent $Root) 'browser\log\startup-edge-marker.txt'
    $marker = if (Test-Path -LiteralPath $markerFile -PathType Leaf) { Sanitize-Text ((Get-Content -LiteralPath $markerFile -Raw).Trim()) } else { $null }
    $markerJson = $null
    if ($marker) {
        try { $markerJson = $marker | ConvertFrom-Json } catch { $markerJson = $null }
    }
    $consoleSession = Get-InteractiveConsoleSessionReport
    $edge = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 })
    $visibleEdge = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    $visibleEdgeOk = [bool]($visibleEdge.Count -gt 0)
    $desktopSnapshotFile = Join-Path (Split-Path -Parent $Root) 'browser\log\startup-edge-browser-health.json'
    $desktopSnapshot = $null
    $desktopSnapshotFresh = $false
    if (Test-Path -LiteralPath $desktopSnapshotFile -PathType Leaf) {
        $desktopSnapshotItem = Get-Item -LiteralPath $desktopSnapshotFile -ErrorAction SilentlyContinue
        if ($desktopSnapshotItem) {
            $desktopSnapshotFresh = [bool](((Get-Date).ToUniversalTime() - $desktopSnapshotItem.LastWriteTimeUtc).TotalSeconds -le 300)
        }
        try {
            $desktopSnapshot = Get-Content -LiteralPath $desktopSnapshotFile -Raw | ConvertFrom-Json
        } catch {
            $desktopSnapshot = $null
        }
    }
    $desktopSnapshotVisibleOk = [bool]($desktopSnapshotFresh -and $desktopSnapshot -and $desktopSnapshot.microsoft_edge.visible_window_detected -eq $true -and $desktopSnapshot.cdp_9223.ok -eq $true -and $desktopSnapshot.target_inventory.chatgpt_target_count -gt 0)
    $effectiveVisibleEdgeOk = [bool]($visibleEdgeOk -or $desktopSnapshotVisibleOk)
    $cdp = $null
    $cdpError = $null
    $cdpOk = $false
    $targets = @()
    $targetError = $null
    try {
        $cdp = Invoke-RestMethod 'http://127.0.0.1:9223/json/version' -TimeoutSec 3
        $cdpOk = [bool]($cdp.Browser -match '^Edg/')
    } catch {
        $cdpError = Sanitize-Text $_.Exception.Message
    }
    if ($cdpOk) {
        try {
            $targets = @(Invoke-RestMethod 'http://127.0.0.1:9223/json/list' -TimeoutSec 3)
        } catch {
            $targetError = Sanitize-Text $_.Exception.Message
        }
    }
    $chatgptTargets = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https://chatgpt\.com' })
    $rootTargets = @($chatgptTargets | Where-Object { $_.url -in @('https://chatgpt.com/','https://chatgpt.com') })
    $chatTargets = @($chatgptTargets | Where-Object { $_.url -match '^https://chatgpt\.com/(c|g|share)/' })
    $settingsTargets = @($chatgptTargets | Where-Object { $_.url -match '#settings' })
    $blankTargets = @($targets | Where-Object { $_.type -eq 'page' -and ($_.url -in @('about:blank','chrome://newtab/','edge://newtab/') -or [string]::IsNullOrWhiteSpace([string]$_.url)) })
    $browserLaunchEvidenceOk = [bool]($marker -or $edge.Count -gt 0)
    $chatgptTargetOk = [bool]($chatgptTargets.Count -gt 0)
    $ok = [bool]($browserLaunchEvidenceOk -and $effectiveVisibleEdgeOk -and $cdpOk -and $chatgptTargetOk)
    $nextAction = if (-not $browserLaunchEvidenceOk) {
        'EDGE_LAUNCH_REQUIRED'
    } elseif (-not $effectiveVisibleEdgeOk) {
        'EDGE_VISIBLE_WINDOW_REQUIRED'
    } elseif (-not $cdpOk) {
        'CDP_RECOVERY_REQUIRED'
    } elseif (-not $chatgptTargetOk) {
        'CHATGPT_VISIBLE_PAGE_REQUIRED'
    } else {
        'CHATGPT_SESSION_CLASSIFICATION_REQUIRED'
    }
    return [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'GREEN' } else { 'RED' }
        next_action = $nextAction
        marker_file = $markerFile
        marker = $marker
        profile = [pscustomobject]@{
            source = if ($markerJson) { $markerJson.profile_source } else { $null }
            dir = if ($markerJson) { $markerJson.profile_dir } else { $null }
            fallback = if ($markerJson) { $markerJson.profile_fallback } else { $null }
            cdp_port = if ($markerJson) { $markerJson.cdp_port } else { $null }
        }
        active_console = $consoleSession
        microsoft_edge = [pscustomobject]@{
            interactive_process_count = $edge.Count
            session_ids = @($edge | Select-Object -ExpandProperty SessionId -Unique | Sort-Object)
            visible_window_count = $visibleEdge.Count
            visible_window_detected = $effectiveVisibleEdgeOk
            local_visible_window_detected = $visibleEdgeOk
            desktop_snapshot_visible_detected = $desktopSnapshotVisibleOk
            visible_window_process_ids = @($visibleEdge | Select-Object -ExpandProperty Id | Sort-Object)
        }
        desktop_snapshot = [pscustomobject]@{
            file = $desktopSnapshotFile
            fresh = $desktopSnapshotFresh
            ok = if ($desktopSnapshot) { $desktopSnapshot.ok } else { $null }
            status = if ($desktopSnapshot) { $desktopSnapshot.status } else { $null }
            next_action = if ($desktopSnapshot) { $desktopSnapshot.next_action } else { $null }
            visible_window_detected = if ($desktopSnapshot) { $desktopSnapshot.microsoft_edge.visible_window_detected } else { $null }
            visible_window_count = if ($desktopSnapshot) { $desktopSnapshot.microsoft_edge.visible_window_count } else { $null }
            session_ids = if ($desktopSnapshot) { $desktopSnapshot.microsoft_edge.session_ids } else { @() }
        }
        cdp_9223 = [pscustomobject]@{
            ok = $cdpOk
            browser = if ($cdp) { $cdp.Browser } else { $null }
            error = $cdpError
        }
        target_inventory = [pscustomobject]@{
            ok = [bool]($cdpOk -and -not $targetError)
            error = $targetError
            total_target_count = $targets.Count
            chatgpt_target_count = $chatgptTargets.Count
            root_target_count = $rootTargets.Count
            chat_target_count = $chatTargets.Count
            settings_target_count = $settingsTargets.Count
            blank_target_count = $blankTargets.Count
            noise_target_count = ($targets.Count - $chatgptTargets.Count - $blankTargets.Count)
        }
        gate = 'marker/process evidence + visible Microsoft Edge window + CDP 9223 ok + ChatGPT page target present'
    }
}

Set-Variable -Name DevConsoleBrowserHealthModuleLoaded -Scope Script -Value $true -Force
