function Resolve-BrowserUserDataDir {
    $browserRoot = Join-Path (Split-Path -Parent $Root) 'browser'
    $fallbackProfileDir = Join-Path $browserRoot 'profile'
    $candidates = @(
        [pscustomobject]@{ source = 'CONSOLE_MCP_BROWSER_USER_DATA_DIR'; value = $env:CONSOLE_MCP_BROWSER_USER_DATA_DIR },
        [pscustomobject]@{ source = 'CONSOLE_MCP_EDGE_USER_DATA_DIR'; value = $env:CONSOLE_MCP_EDGE_USER_DATA_DIR },
        [pscustomobject]@{ source = 'NETWORK_MCP_BROWSER_USER_DATA_DIR'; value = $env:NETWORK_MCP_BROWSER_USER_DATA_DIR }
    )
    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate.value)) {
            $resolved = [System.IO.Path]::GetFullPath([string]$candidate.value)
            return [pscustomobject]@{ source = $candidate.source; path = $resolved; fallback = $false }
        }
    }
    return [pscustomobject]@{ source = 'fallback-browser-profile'; path = $fallbackProfileDir; fallback = $true }
}

function ConvertTo-BrowserArgumentString {
    param([string[]]$Arguments)
    return (@($Arguments) | ForEach-Object {
        $value = [string]$_
        if ($value -match '[\s"]') {
            '"' + ($value -replace '"', '\"') + '"'
        } else {
            $value
        }
    }) -join ' '
}

function Start-VisibleEdge {
    $browserRoot = Join-Path (Split-Path -Parent $Root) 'browser'
    $logDir = Join-Path $browserRoot 'log'
    $profile = Resolve-BrowserUserDataDir
    $profileDir = $profile.path
    $markerFile = Join-Path $logDir 'startup-edge-marker.txt'
    New-Item -ItemType Directory -Force -Path $logDir, $profileDir | Out-Null
    $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    if (-not (Test-Path -LiteralPath $edgeExe -PathType Leaf)) { $edgeExe = (Get-Command msedge.exe -ErrorAction Stop).Source }
    $args = @('--remote-debugging-port=9223', "--user-data-dir=$profileDir", '--no-first-run', '--new-window', '--start-maximized', 'https://chatgpt.com/')
    $argumentString = ConvertTo-BrowserArgumentString -Arguments $args
    $launchMethods = @()
    $shell = New-Object -ComObject Shell.Application
    $shell.ShellExecute($edgeExe, $argumentString, (Split-Path -Parent $edgeExe), 'open', 3) | Out-Null
    $launchMethods += 'Shell.Application.ShellExecute'

    $process = $null
    $visibleProcessIds = @()
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        $managedEdge = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
            ([string]$_.CommandLine).Contains('--remote-debugging-port=9223') -or ([string]$_.CommandLine).Contains($profileDir)
        })
        if ($managedEdge.Count -gt 0) {
            $process = $managedEdge | Sort-Object CreationDate -Descending | Select-Object -First 1
        }
        $visibleEdge = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($visibleEdge.Count -gt 0) {
            $visibleProcessIds = @($visibleEdge | Select-Object -ExpandProperty Id | Sort-Object)
            break
        }
    }

    if ($visibleProcessIds.Count -eq 0) {
        $cmdArguments = '/c start "" /max "' + $edgeExe + '" ' + $argumentString
        Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArguments -WindowStyle Normal | Out-Null
        $launchMethods += 'cmd.exe start /max'
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            $managedEdge = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
                ([string]$_.CommandLine).Contains('--remote-debugging-port=9223') -or ([string]$_.CommandLine).Contains($profileDir)
            })
            if ($managedEdge.Count -gt 0) {
                $process = $managedEdge | Sort-Object CreationDate -Descending | Select-Object -First 1
            }
            $visibleEdge = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
            if ($visibleEdge.Count -gt 0) {
                $visibleProcessIds = @($visibleEdge | Select-Object -ExpandProperty Id | Sort-Object)
                break
            }
        }
    }

    $edgePid = if ($process) { $process.ProcessId } else { $null }
    $visibleWindowDetected = [bool]($visibleProcessIds.Count -gt 0)
    $marker = [pscustomobject]@{
        at = (Get-Date).ToString('o')
        status = if ($visibleWindowDetected) { 'EDGE_STARTED_VISIBLE' } else { 'EDGE_STARTED_NO_VISIBLE_WINDOW' }
        pid = $edgePid
        cdp_port = 9223
        edge_exe = $edgeExe
        profile_source = $profile.source
        profile_dir = $profileDir
        profile_fallback = $profile.fallback
        visible_window_detected = $visibleWindowDetected
        visible_window_process_ids = $visibleProcessIds
        launch_method = ($launchMethods -join ' -> ')
    }
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerFile -Encoding utf8
    return [pscustomobject]@{ ok = $visibleWindowDetected; status = $marker.status; pid = $edgePid; marker_file = $markerFile; cdp_port = 9223; profile_source = $profile.source; profile_dir = $profileDir; profile_fallback = $profile.fallback; visible_window_detected = $visibleWindowDetected; visible_window_process_ids = $visibleProcessIds; launch_method = ($launchMethods -join ' -> ') }
}

Set-Variable -Name DevConsoleBrowserLaunchModuleLoaded -Scope Script -Value $true -Force
