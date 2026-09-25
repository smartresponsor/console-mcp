function Write-WatchdogState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object[]]$Actions = @(),
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )

    Ensure-Directories
    $state = [ordered]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        state_file = $WatchdogStateFile
        lock_file = $WatchdogLockFile
        log_file = $WatchdogLogFile
        actions = @($Actions)
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $json = ($state | ConvertTo-Json -Depth 30)
    $json | Set-Content -LiteralPath $WatchdogStateFile -Encoding utf8
    Write-SafeLogLine -Path $WatchdogLogFile -Text ($json -replace "`r?`n", ' ')
    Write-ServerLifecycleEvent -Operation 'watchdog' -Phase $Status -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return [pscustomobject]$state
}

function Get-WatchdogState {
    if (-not (Test-Path -LiteralPath $WatchdogStateFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            status = 'never-run'
            state_file = $WatchdogStateFile
            lock_file = $WatchdogLockFile
        }
    }

    try {
        return (Get-Content -LiteralPath $WatchdogStateFile -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'state-file-unreadable'
            state_file = $WatchdogStateFile
            lock_file = $WatchdogLockFile
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-StateFileFreshness {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxAgeSeconds = 120
    )

    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) {
        return [pscustomobject]@{ exists = $false; fresh = $false; age_seconds = $null; max_age_seconds = $MaxAgeSeconds; last_write_time = $null }
    }

    $ageSeconds = [Math]::Round(((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalSeconds, 3)
    return [pscustomobject]@{
        exists = $true
        fresh = [bool]($ageSeconds -le $MaxAgeSeconds)
        age_seconds = $ageSeconds
        max_age_seconds = $MaxAgeSeconds
        last_write_time = $item.LastWriteTime.ToString('o')
    }
}

function Get-WatchdogStateStatus {
    $fullHealState = Get-WatchdogState
    $fullHealFreshness = Get-StateFileFreshness -Path $WatchdogStateFile -MaxAgeSeconds 120
    $cadenceFreshness = Get-StateFileFreshness -Path $WatchdogLoopStateFile -MaxAgeSeconds 30
    $cadenceState = $null
    if ($cadenceFreshness.exists) {
        try { $cadenceState = Get-Content -LiteralPath $WatchdogLoopStateFile -Raw | ConvertFrom-Json -Depth 30 } catch { $cadenceState = $null }
    }

    $fullHealOk = [bool]($fullHealState.ok -and $fullHealFreshness.fresh)
    $cadenceOk = [bool]($cadenceState -and $cadenceState.ok -eq $true -and $cadenceFreshness.fresh)
    $effectiveSource = if ($fullHealOk) { 'full_heal' } elseif ($cadenceOk) { 'cadence_loop' } else { 'none' }
    $effectiveFreshness = if ($effectiveSource -eq 'cadence_loop') { $cadenceFreshness } else { $fullHealFreshness }
    $ok = [bool]($fullHealOk -or $cadenceOk)
    $status = if ($fullHealOk) {
        [string]$fullHealState.status
    } elseif ($cadenceOk) {
        [string]$cadenceState.status
    } elseif (-not $fullHealFreshness.exists -and -not $cadenceFreshness.exists) {
        'NEVER_RUN'
    } else {
        'STALE'
    }

    return [pscustomobject]@{
        ok = $ok
        status = $status
        freshness = $effectiveFreshness
        effective_source = $effectiveSource
        full_heal_freshness = $fullHealFreshness
        cadence_freshness = $cadenceFreshness
        state = $fullHealState
        cadence_state = $cadenceState
    }
}

