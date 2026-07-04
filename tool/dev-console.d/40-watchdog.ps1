function Invoke-WatchdogPreflight {
    param([string]$Purpose = 'preflight')
    $heal = $null
    try {
        $heal = Invoke-WatchdogHeal | ConvertFrom-Json
    } catch {
        $heal = [pscustomobject]@{
            ok = $false
            status = 'WATCHDOG_HEAL_COMMAND_FAILED'
            error = Sanitize-Text $_.Exception.Message
        }
    }
    $loop = Get-WatchdogLoopProcessState
    $snapshot = Invoke-StackSnapshot -Purpose ("preflight-$Purpose")
    $ok = [bool]($loop.running -and $heal.ok -eq $true -and $snapshot.ok -eq $true)
    $preflight = [pscustomobject]@{
        ok = $ok
        status = if ($ok) { 'WATCHDOG_PREFLIGHT_GREEN' } else { 'WATCHDOG_PREFLIGHT_RED' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        heal = $heal
        loop = $loop
        snapshot_file = $snapshot.stack_file
    }
    Write-StateArtifact -Directory $WatchdogSnapshotDir -Name (New-StackOperationId -Purpose "preflight-$Purpose") -Payload $preflight | Out-Null
    if (-not $ok) { throw 'Watchdog preflight failed.' }
    return $preflight
}

Set-Variable -Name DevConsoleWatchdogModuleLoaded -Scope Script -Value $true -Force
