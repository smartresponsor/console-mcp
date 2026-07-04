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

function Start-VisibleEdge {
    $browserRoot = Join-Path (Split-Path -Parent $Root) 'browser'
    $logDir = Join-Path $browserRoot 'log'
    $profile = Resolve-BrowserUserDataDir
    $profileDir = $profile.path
    $markerFile = Join-Path $logDir 'startup-edge-marker.txt'
    New-Item -ItemType Directory -Force -Path $logDir, $profileDir | Out-Null
    $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    if (-not (Test-Path -LiteralPath $edgeExe -PathType Leaf)) { $edgeExe = (Get-Command msedge.exe -ErrorAction Stop).Source }
    $args = @('--remote-debugging-port=9223', "--user-data-dir=$profileDir", '--no-first-run', '--new-window', 'https://chatgpt.com/')
    $process = Start-Process -FilePath $edgeExe -ArgumentList $args -PassThru -WindowStyle Normal
    $marker = [pscustomobject]@{
        at = (Get-Date).ToString('o')
        status = 'EDGE_STARTED'
        pid = $process.Id
        cdp_port = 9223
        edge_exe = $edgeExe
        profile_source = $profile.source
        profile_dir = $profileDir
        profile_fallback = $profile.fallback
    }
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerFile -Encoding utf8
    Start-Sleep -Seconds 2
    return [pscustomobject]@{ ok = $true; status = 'EDGE_STARTED'; pid = $process.Id; marker_file = $markerFile; cdp_port = 9223; profile_source = $profile.source; profile_dir = $profileDir; profile_fallback = $profile.fallback }
}

Set-Variable -Name DevConsoleBrowserLaunchModuleLoaded -Scope Script -Value $true -Force
