function Get-WatchdogTaskIntegrityPreviousState {
    if (-not (Test-Path -LiteralPath $WatchdogTaskIntegrityStateFile -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $WatchdogTaskIntegrityStateFile -Raw | ConvertFrom-Json -Depth 30 } catch { return $null }
}

function Write-WatchdogTaskIntegrityState {
    param([Parameter(Mandatory = $true)]$State)
    $temporary = "$WatchdogTaskIntegrityStateFile.$PID.tmp"
    $State | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $WatchdogTaskIntegrityStateFile -Force
}

function Invoke-WatchdogTaskIntegritySample {
    $lockPath = Join-Path $RunDir 'watchdog-task-integrity-sample.lock'
    $lockHandle = $null
    try {
        try {
            $lockHandle = [System.IO.File]::Open($lockPath,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
        } catch [System.IO.IOException] {
            return [pscustomobject]@{ ok=$true; status='WATCHDOG_TASK_INTEGRITY_SAMPLE_ALREADY_RUNNING'; sampled=$false; lock_file=$lockPath }
        }
        $task = Show-WatchdogTask | ConvertFrom-Json -Depth 30
        $autologon = Get-AutologonReport
        $console = Get-ConsoleSessionReport
        $taskOk = [bool]($task.exists -and $task.declaration -and $task.declaration.ok)
        $ok = [bool]($taskOk -and $autologon.ok -and $console.ok)
        $sample = [pscustomobject]@{
            schema_version = 1
            sampled_at = (Get-Date).ToUniversalTime().ToString('o')
            sampler_pid = $PID
            ok = $ok
            status = if($ok){'TASK_AND_SESSION_INTEGRITY_HEALTHY'}else{'TASK_AND_SESSION_INTEGRITY_UNHEALTHY'}
            repair_required = (-not $ok)
            detail = [pscustomobject]@{ task=$task; autologon=$autologon; console_session=$console }
        }
        Write-WatchdogTaskIntegrityState -State $sample
        return [pscustomobject]@{ ok=$ok; status='WATCHDOG_TASK_INTEGRITY_SAMPLE_COMPLETED'; sampled=$true; sample=$sample; lock_file=$lockPath }
    } finally {
        if($lockHandle){ try{$lockHandle.Dispose()}catch{} }
    }
}

function Start-WatchdogTaskIntegritySample {
    $devConsole = Join-Path $Root 'tool\dev-console.ps1'
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $process = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$devConsole,'watchdog-task-integrity-sample') -WindowStyle Hidden -PassThru
    [pscustomobject]@{ ok=$true; status='WATCHDOG_TASK_INTEGRITY_SAMPLE_STARTED'; repair_required=$false; detail=[pscustomobject]@{sampler_pid=[int]$process.Id; state_file=$WatchdogTaskIntegrityStateFile} }
}

function Get-WatchdogTaskIntegrityCadenceResult {
    $previous = Get-WatchdogTaskIntegrityPreviousState
    $started = Start-WatchdogTaskIntegritySample
    if(-not $previous){
        return [pscustomobject]@{ ok=$true; status='WATCHDOG_TASK_INTEGRITY_SAMPLE_STARTED'; repair_required=$false; detail=[pscustomobject]@{sample_start=$started; cached_sample=$null} }
    }
    $sampledAt = try { Convert-WatchdogCadenceTimestampUtc -Value $previous.sampled_at } catch { $null }
    $age = if($sampledAt){ [Math]::Round(((Get-Date).ToUniversalTime()-$sampledAt).TotalSeconds,1) } else { $null }
    $stale = [bool]($null -eq $age -or $age -lt -5 -or $age -gt 900)
    if($stale){
        return [pscustomobject]@{ ok=$true; status='WATCHDOG_TASK_INTEGRITY_REFRESHING_STALE'; repair_required=$false; detail=[pscustomobject]@{sample_start=$started; cached_sample=$previous; cached_age_seconds=$age} }
    }
    return [pscustomobject]@{ ok=[bool]$previous.ok; status=[string]$previous.status; repair_required=[bool]$previous.repair_required; detail=[pscustomobject]@{sample_start=$started; cached_sample=$previous; cached_age_seconds=$age} }
}
