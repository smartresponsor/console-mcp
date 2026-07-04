function Start-VisibleEdge {
    $browserRoot = Join-Path (Split-Path -Parent $Root) 'browser'
    $logDir = Join-Path $browserRoot 'log'
    $profileDir = Join-Path $browserRoot 'profile'
    $markerFile = Join-Path $logDir 'startup-edge-marker.txt'
    New-Item -ItemType Directory -Force -Path $logDir, $profileDir | Out-Null
    $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    if (-not (Test-Path -LiteralPath $edgeExe -PathType Leaf)) { $edgeExe = (Get-Command msedge.exe -ErrorAction Stop).Source }
    $args = @('--remote-debugging-port=9223', "--user-data-dir=$profileDir", '--no-first-run', '--new-window', 'https://chatgpt.com/')
    $process = Start-Process -FilePath $edgeExe -ArgumentList $args -PassThru -WindowStyle Normal
    ("{0} startup edge launch pid={1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff zzz'), $process.Id) | Set-Content -LiteralPath $markerFile -Encoding utf8
    Start-Sleep -Seconds 2
    return [pscustomobject]@{ ok = $true; status = 'EDGE_STARTED'; pid = $process.Id; marker_file = $markerFile }
}

Set-Variable -Name DevConsoleBrowserLaunchModuleLoaded -Scope Script -Value $true -Force
