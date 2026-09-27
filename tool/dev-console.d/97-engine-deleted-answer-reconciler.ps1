# Reconcile impossible answer-capture states after the backing conversation is confirmed deleted.

function Get-EngineDeletedAnswerReconcilerIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_DELETED_ANSWER_RECONCILER_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_DELETED_ANSWER_RECONCILER_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 30 -and $configured -le 3600) {
        return $configured
    }
    return 60
}

function Start-EngineDeletedAnswerReconciler {
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\engine-deleted-answer-reconciler-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{ ok=$false; status='ENGINE_DELETED_ANSWER_RECONCILER_CLI_MISSING'; repair_required=$false; detail=[pscustomobject]@{script_path=$scriptPath} }
    }
    try {
        $process = Start-Process -FilePath $node.Source -ArgumentList @('--enable-source-maps',$scriptPath,"--root=$Root",'--max-work=20') -WindowStyle Hidden -PassThru
        return [pscustomobject]@{ ok=$true; status='ENGINE_DELETED_ANSWER_RECONCILER_STARTED'; repair_required=$false; detail=[pscustomobject]@{sampler_pid=[int]$process.Id} }
    } catch {
        return [pscustomobject]@{ ok=$false; status='ENGINE_DELETED_ANSWER_RECONCILER_START_FAILED'; repair_required=$false; detail=[pscustomobject]@{error=Sanitize-Text $_.Exception.Message} }
    }
}

Register-WatchdogCadenceLane `
    -Name 'engine_deleted_answer_reconciler' `
    -IntervalSeconds (Get-EngineDeletedAnswerReconcilerIntervalSeconds) `
    -InsertBefore 'build_fingerprint' `
    -Invoke { Start-EngineDeletedAnswerReconciler }

Set-Variable -Name DevConsoleEngineDeletedAnswerReconcilerModuleLoaded -Scope Script -Value $true -Force
