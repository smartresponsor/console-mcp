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
    $ok = [bool]($heal.ok -eq $true -and $snapshot.ok -eq $true -and $loop.running -eq $true)
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
        $detail = if ($heal -and $heal.detail) { $heal.detail } else { $null }
        if (Get-Command Invoke-WatchdogAlertIfNeeded -ErrorAction SilentlyContinue) {
            Invoke-WatchdogAlertIfNeeded -Status 'WATCHDOG_PREFLIGHT_RED' -Ok $false -Reason "purpose=$Purpose heal_status=$($heal.status) snapshot_ok=$($snapshot.ok)"
        }
        $localChatgptOk = if ($detail -and $detail.local_chatgpt) { $detail.local_chatgpt.ok } else { $null }
        $publicOk = if ($detail -and $detail.public) { $detail.public.ok } else { $null }
        $tunnelRunning = if ($detail -and $detail.tunnel) { $detail.tunnel.running } else { $null }
        $freshnessOk = if ($detail -and $detail.chatgpt_freshness) { $detail.chatgpt_freshness.ok } else { $null }
        $browserOk = if ($browser) { $browser.ok } else { $null }
        $browserStatus = if ($browser) { $browser.status } else { $null }
        $browserRecoveryAction = if ($browser) { $browser.recovery_action } else { $null }
        $nextAction = if ($after) { $after.next_action } else { $null }
        $markerPresent = if ($after) { [bool]$after.marker } else { $null }
        $edgeProcessCount = if ($after) { $after.microsoft_edge.interactive_process_count } else { $null }
        $cdpOk = if ($after) { $after.cdp_9223.ok } else { $null }
        $chatgptTargetCount = if ($after) { $after.target_inventory.chatgpt_target_count } else { $null }
        throw ("Watchdog preflight failed. heal_ok={0}; heal_status={1}; heal_error={2}; loop_running={3}; snapshot_ok={4}; local_chatgpt_ok={5}; public_ok={6}; tunnel_running={7}; freshness_ok={8}; browser_ok={9}; browser_status={10}; browser_recovery_action={11}; next_action={12}; marker_present={13}; edge_process_count={14}; cdp_ok={15}; chatgpt_target_count={16}" -f ($heal.ok -eq $true), $heal.status, $heal.error, $loop.running, $snapshot.ok, $localChatgptOk, $publicOk, $tunnelRunning, $freshnessOk, $browserOk, $browserStatus, $browserRecoveryAction, $nextAction, $markerPresent, $edgeProcessCount, $cdpOk, $chatgptTargetCount)
    }
    return $preflight
}

