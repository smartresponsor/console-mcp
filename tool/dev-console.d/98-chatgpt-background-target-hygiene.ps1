# Bounded browser hygiene for idle ChatGPT conversation targets.
# Runs separately from task-state lifecycle reaping so generic tab cleanup never changes engine state.

function Get-ChatgptBackgroundTargetHygieneIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_BACKGROUND_TARGET_HYGIENE_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_BACKGROUND_TARGET_HYGIENE_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 3600) {
        return $configured
    }
    return 60
}

function Start-ChatgptBackgroundTargetHygiene {
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\engine-background-target-hygiene-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{ ok=$false; status='ENGINE_BACKGROUND_TARGET_HYGIENE_CLI_MISSING'; repair_required=$false; detail=[pscustomobject]@{script_path=$scriptPath} }
    }
    try {
        $process = Start-Process -FilePath $node.Source -ArgumentList @('--enable-source-maps',$scriptPath,"--root=$Root",'--ports=9223','--max-close=3','--timeout-ms=3000') -WindowStyle Hidden -PassThru
        return [pscustomobject]@{ ok=$true; status='ENGINE_BACKGROUND_TARGET_HYGIENE_STARTED'; repair_required=$false; detail=[pscustomobject]@{sampler_pid=[int]$process.Id; state_file=(Join-Path $RunDir 'engine\background-target-hygiene-last.json')} }
    } catch {
        return [pscustomobject]@{ ok=$false; status='ENGINE_BACKGROUND_TARGET_HYGIENE_START_FAILED'; repair_required=$false; detail=[pscustomobject]@{error=Sanitize-Text $_.Exception.Message} }
    }
}

Register-WatchdogCadenceLane `
    -Name 'chatgpt_background_target_hygiene' `
    -IntervalSeconds (Get-ChatgptBackgroundTargetHygieneIntervalSeconds) `
    -InsertBefore 'build_fingerprint' `
    -Invoke { Start-ChatgptBackgroundTargetHygiene }

Set-Variable -Name DevConsoleChatgptBackgroundTargetHygieneModuleLoaded -Scope Script -Value $true -Force
