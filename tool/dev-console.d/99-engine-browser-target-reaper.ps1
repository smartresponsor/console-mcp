# Frequent resource-only cleanup for completed ready_to_delete engine conversations.
# The lane starts an external Node sampler and returns immediately so watchdog heartbeat is never blocked by CDP.

function Get-EngineBrowserTargetReaperIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 3600) {
        return $configured
    }
    return 30
}

function Start-EngineBrowserTargetReaper {
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\engine-browser-target-reaper-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{ ok=$false; status='ENGINE_BROWSER_TARGET_REAPER_CLI_MISSING'; repair_required=$false; detail=[pscustomobject]@{script_path=$scriptPath} }
    }
    try {
        $process = Start-Process -FilePath $node.Source -ArgumentList @('--enable-source-maps',$scriptPath,"--root=$Root",'--ports=9223','--max-close=10','--timeout-ms=3000') -WindowStyle Hidden -PassThru
        return [pscustomobject]@{ ok=$true; status='ENGINE_BROWSER_TARGET_REAPER_STARTED'; repair_required=$false; detail=[pscustomobject]@{sampler_pid=[int]$process.Id; state_file=(Join-Path $RunDir 'engine\browser-target-reaper-last.json')} }
    } catch {
        return [pscustomobject]@{ ok=$false; status='ENGINE_BROWSER_TARGET_REAPER_START_FAILED'; repair_required=$false; detail=[pscustomobject]@{error=Sanitize-Text $_.Exception.Message} }
    }
}

Register-WatchdogCadenceLane `
    -Name 'engine_target_reaper' `
    -IntervalSeconds (Get-EngineBrowserTargetReaperIntervalSeconds) `
    -InsertBefore 'build_fingerprint' `
    -Invoke { Start-EngineBrowserTargetReaper }

Set-Variable -Name DevConsoleEngineTargetReaperModuleLoaded -Scope Script -Value $true -Force
