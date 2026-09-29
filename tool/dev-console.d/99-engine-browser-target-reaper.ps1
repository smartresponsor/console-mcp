# Frequent resource-only cleanup for completed ready_to_delete engine conversations.
# The lane starts an external Node sampler and returns immediately so watchdog heartbeat is never blocked by CDP.

function Get-EngineBrowserTargetReaperIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 3600) {
        return $configured
    }
    return 30
}

function Get-EngineBrowserTargetReaperRateLimitBackoffSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_ENGINE_TARGET_REAPER_RATE_LIMIT_BACKOFF_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 900) {
        return $configured
    }
    return 120
}

function Get-EngineBrowserTargetReaperRateLimitDeferral {
    $stateFile = Join-Path $RunDir 'engine\browser-target-reaper-last.json'
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $null }
    try {
        $receipt = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -Depth 40
        $rateLimited = $false
        foreach ($result in @($receipt.conversation_lifecycle.results)) {
            $recovery = $result.answer_recovery
            if (-not $recovery) { continue }
            if ([string]$recovery.status -eq 'ENGINE_ANSWER_RECOVERY_RATE_LIMITED' -or
                [string]$recovery.capture_status -eq 'CHAT_CONVERSATION_READ_RATE_LIMITED' -or
                [string]$recovery.conversation_read.status -eq 'CHAT_CONVERSATION_READ_RATE_LIMITED') {
                $rateLimited = $true
                break
            }
        }
        if (-not $rateLimited) { return $null }
        $receiptAt = $receipt.at
        $completedAt = if ($receiptAt -is [datetimeoffset]) {
            $receiptAt.UtcDateTime
        } elseif ($receiptAt -is [datetime]) {
            $receiptAt.ToUniversalTime()
        } else {
            [datetimeoffset]::Parse([string]$receiptAt).UtcDateTime
        }
        $backoffSeconds = Get-EngineBrowserTargetReaperRateLimitBackoffSeconds
        $ageSeconds = [math]::Max(0, ((Get-Date).ToUniversalTime() - $completedAt).TotalSeconds)
        $remainingSeconds = [math]::Ceiling($backoffSeconds - $ageSeconds)
        if ($remainingSeconds -le 0) { return $null }
        return [pscustomobject]@{
            status = 'ENGINE_BROWSER_TARGET_REAPER_RATE_LIMIT_DEFERRED'
            receipt_at = if ($receiptAt -is [datetime]) { $receiptAt.ToUniversalTime().ToString('o') } elseif ($receiptAt -is [datetimeoffset]) { $receiptAt.ToUniversalTime().ToString('o') } else { [string]$receiptAt }
            backoff_seconds = $backoffSeconds
            age_seconds = [math]::Round($ageSeconds, 3)
            remaining_seconds = [int]$remainingSeconds
            state_file = $stateFile
        }
    } catch {
        return $null
    }
}

function Start-EngineBrowserTargetReaper {
    $deferral = Get-EngineBrowserTargetReaperRateLimitDeferral
    if ($deferral) {
        return [pscustomobject]@{ ok=$true; status='ENGINE_BROWSER_TARGET_REAPER_RATE_LIMIT_DEFERRED'; repair_required=$false; detail=$deferral }
    }
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

function Get-EngineDispatchDrainIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_ENGINE_DISPATCH_DRAIN_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_ENGINE_DISPATCH_DRAIN_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 3600) {
        return $configured
    }
    return 30
}

function Start-EngineDispatchDrain {
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\engine\engine-cli.js'
    $pidFile = Join-Path $RunDir 'engine\dispatch-drain.pid'
    $stateFile = Join-Path $RunDir 'engine\dispatch-drain-last.json'
    $errorFile = Join-Path $LogDir 'engine\dispatch-drain-error.log'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{ ok=$false; status='ENGINE_DISPATCH_DRAIN_CLI_MISSING'; repair_required=$false; detail=[pscustomobject]@{script_path=$scriptPath} }
    }
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        $existingPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$existingPid) -and $existingPid -gt 0) {
            $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($existing) {
                return [pscustomobject]@{ ok=$true; status='ENGINE_DISPATCH_DRAIN_ALREADY_RUNNING'; repair_required=$false; detail=[pscustomobject]@{pid=$existingPid; state_file=$stateFile} }
            }
        }
    }
    $engineLogDir = Split-Path -Parent $errorFile
    if (-not (Test-Path -LiteralPath $engineLogDir -PathType Container)) { New-Item -ItemType Directory -Force -Path $engineLogDir | Out-Null }
    try {
        $process = Start-Process -FilePath $node.Source -ArgumentList @('--enable-source-maps',$scriptPath,'dispatch-drain','--max-steps=5','--ports=9223','--recover-composer') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stateFile -RedirectStandardError $errorFile -PassThru
        Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -Encoding ascii
        return [pscustomobject]@{ ok=$true; status='ENGINE_DISPATCH_DRAIN_STARTED'; repair_required=$false; detail=[pscustomobject]@{pid=[int]$process.Id; state_file=$stateFile; error_file=$errorFile} }
    } catch {
        return [pscustomobject]@{ ok=$false; status='ENGINE_DISPATCH_DRAIN_START_FAILED'; repair_required=$false; detail=[pscustomobject]@{error=Sanitize-Text $_.Exception.Message} }
    }
}

Register-WatchdogCadenceLane `
    -Name 'engine_dispatch_drain' `
    -IntervalSeconds (Get-EngineDispatchDrainIntervalSeconds) `
    -InsertBefore 'build_fingerprint' `
    -Invoke { Start-EngineDispatchDrain }

Set-Variable -Name DevConsoleEngineTargetReaperModuleLoaded -Scope Script -Value $true -Force
