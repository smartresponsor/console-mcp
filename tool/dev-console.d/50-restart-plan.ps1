function Get-RestartAllPlan {
    $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $build = Get-BuildOutputReport
    $freshness = Get-ChatgptRuntimeFreshness
    $browser = Get-BrowserStackHealthReport
    $blocked = @()
    if ($build.build_needed) { $blocked += 'build_output_stale' }
    if ($chatgpt.port_conflict -or $codex.port_conflict) { $blocked += 'port_conflict' }
    if ($browser.next_action -eq 'EDGE_VISIBLE_WINDOW_REQUIRED') { $blocked += 'interactive_browser_recovery_required' }
    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RESTART_ALL_PLAN_READY' } else { 'RESTART_ALL_PLAN_BLOCKED' }
        command = 'restart-all'
        mode = 'warm'
        will_stop_anything = $false
        target_profiles = @('chatgpt-oauth', 'codex-bearer', 'tunnel')
        safe_to_execute = $safe
        reason = if ($safe) { 'preflight_ready' } else { 'preflight_blocked' }
        blocked_reasons = $blocked
        build_output = $build
        freshness = $freshness
        services = [pscustomobject]@{
            chatgpt_oauth = $chatgpt
            codex_bearer = $codex
            tunnel = $tunnel
        }
        browser = $browser
        restart = Get-RestartState
        next_action = if ($safe) { 'run restart-all only if a broad stack restart is explicitly intended' } else { 'inspect blockers before restart-all' }
    } | ConvertTo-Json -Depth 30
}

