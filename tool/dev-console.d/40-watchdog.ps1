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
    if (-not $ok) {
        $browser = if ($snapshot -and $snapshot.browser) { $snapshot.browser } else { $null }
        $after = if ($browser -and $browser.after) { $browser.after } else { $null }
        throw ("Watchdog preflight failed. heal_ok={0}; heal_status={1}; loop_running={2}; snapshot_ok={3}; browser_ok={4}; browser_status={5}; browser_recovery_action={6}; next_action={7}; marker_present={8}; edge_process_count={9}; cdp_ok={10}; chatgpt_target_count={11}" -f ($heal.ok -eq $true), $heal.status, $loop.running, $snapshot.ok, $(if ($browser) { $browser.ok } else { $null }), $(if ($browser) { $browser.status } else { $null }), $(if ($browser) { $browser.recovery_action } else { $null }), $(if ($after) { $after.next_action } else { $null }), $(if ($after) { [bool]$after.marker } else { $null }), $(if ($after) { $after.microsoft_edge.interactive_process_count } else { $null }), $(if ($after) { $after.cdp_9223.ok } else { $null }), $(if ($after) { $after.target_inventory.chatgpt_target_count } else { $null }))
    }
    return $preflight
}

Set-Variable -Name DevConsoleWatchdogModuleLoaded -Scope Script -Value $true -Force
