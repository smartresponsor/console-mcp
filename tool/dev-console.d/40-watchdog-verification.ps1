function Invoke-ScheduledTaskDeclarationSelfHeal {
    $before = Show-WatchdogTask | ConvertFrom-Json
    if (-not $before.exists) {
        Install-WatchdogTask | Out-Null
        return [pscustomobject]@{ ok = $true; action_taken = 'installed_missing_task'; before = $before; after = (Show-WatchdogTask | ConvertFrom-Json) }
    }
    if (-not $before.declaration.ok) {
        Install-WatchdogTask | Out-Null
        $after = Show-WatchdogTask | ConvertFrom-Json
        return [pscustomobject]@{ ok = [bool]$after.declaration.ok; action_taken = 'reinstalled_drifted_task'; drift = $before.declaration.drift; before = $before; after = $after }
    }
    return [pscustomobject]@{ ok = $true; action_taken = 'none'; before = $before; after = $before }
}

function Invoke-WatchdogVerifyAndHeal {
    param(
        [int]$MaxAttempts = 3,
        [int]$SettleSeconds = 10
    )

    $taskHeal = $null
    try {
        $taskHeal = Invoke-ScheduledTaskDeclarationSelfHeal
    } catch {
        $taskHeal = [pscustomobject]@{ ok = $false; action_taken = 'failed'; error = Sanitize-Text $_.Exception.Message }
    }

    $attempts = [System.Collections.Generic.List[object]]::new()
    $ready = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $launch = $null
        try { $launch = Start-WatchdogLoop | ConvertFrom-Json } catch { $launch = [pscustomobject]@{ ok = $false; error = Sanitize-Text $_.Exception.Message } }
        Start-Sleep -Seconds $SettleSeconds
        $ready = Get-SystemReadyState
        $attempts.Add([pscustomobject]@{ attempt = $attempt; launch = $launch; ok = $ready.ok; status = $ready.status; not_ready = $ready.not_ready; failure_classification = $ready.failure_classification }) | Out-Null
        if ($ready.ok) { break }
    }

    $ok = [bool]($ready -and $ready.ok)
    $status = if ($ok) { 'VERIFY_AND_HEAL_READY' } else { 'VERIFY_AND_HEAL_EXHAUSTED' }
    if (-not $ok) {
        $reasonText = "system not ready after $MaxAttempts attempts; not_ready=$(($ready.not_ready) -join ','); failure_reason=$($ready.failure_classification.reason)"
        if (Get-Command Invoke-WatchdogAlertIfNeeded -ErrorAction SilentlyContinue) {
            Invoke-WatchdogAlertIfNeeded -Status $status -Ok $false -Reason $reasonText
        }
    }
    Write-WatchdogState -Status $status -Ok $ok -Actions @([pscustomobject]@{ action = 'watchdog-verify-and-heal'; reason = 'bounded end-to-end SYSTEM_READY verification with retry'; task_heal = $taskHeal }) -Detail ([pscustomobject]@{ task_heal = $taskHeal; attempts = @($attempts); system_ready = $ready }) | Out-Null

    return [pscustomobject]@{
        ok = $ok
        status = $status
        max_attempts = $MaxAttempts
        settle_seconds = $SettleSeconds
        task_heal = $taskHeal
        attempts = @($attempts)
        system_ready = $ready
        next_action = if ($ok) { 'none' } else { 'manual intervention required: full Scheduled Task unregister/recreate was deliberately not attempted automatically (risk of racing a concurrently-running task instance or a caller mid Start-ScheduledTask); inspect failure_classification, then repair the underlying cause and re-run watchdog-verify-and-heal' }
    }
}

