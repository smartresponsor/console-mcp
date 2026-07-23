function Get-RuntimeReplaceState {
    if (-not (Test-Path -LiteralPath $RuntimeReplaceStateFile -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $RuntimeReplaceStateFile -Raw | ConvertFrom-Json -Depth 20)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'RUNTIME_REPLACE_STATE_UNREADABLE'
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Write-RuntimeReplaceState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [object]$Plan = $null,
        [object]$Detail = $null,
        [string]$ErrorMessage = $null
    )
    Ensure-Directories
    $state = [pscustomobject]@{
        ok = $Ok
        status = $Status
        at = (Get-Date).ToString('o')
        state_file = $RuntimeReplaceStateFile
        plan = $Plan
        detail = $Detail
        error = if ($ErrorMessage) { Sanitize-Text $ErrorMessage } else { $null }
    }
    $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $RuntimeReplaceStateFile -Encoding utf8
    Write-ServerLifecycleEvent -Operation 'runtime-replace' -Mode 'warm' -Scope 'chatgpt' -Phase $Status -Status $Status -Ok $Ok -Detail $Detail -ErrorMessage $ErrorMessage | Out-Null
    return $state
}

function New-ConsoleDevRuntimeReplacePlan {
    param(
        [ValidateSet('chatgpt')][string]$Kind = 'chatgpt',
        [ValidateSet('warm')][string]$Mode = 'warm',
        [int]$CooldownSeconds = 90
    )
    $spec = Get-ChatgptSpec
    $service = Get-ManagedProcessState -Spec $spec
    $freshness = Get-ChatgptRuntimeFreshness
    $local = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $build = Get-BuildOutputReport
    $last = Get-RuntimeReplaceState
    $blocked = @()
    $staleProof = @()

    foreach ($reason in @($freshness.reasons)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$reason)) { $staleProof += [string]$reason }
    }
    if ($freshness.status -eq 'STALE' -and $staleProof.Count -eq 0) { $staleProof += 'runtime_stale' }

    if ($service.port_conflict) { $blocked += 'foreign_listener_or_port_conflict' }
    if (-not $service.running) { $blocked += 'target_runtime_not_running' }
    if (-not $service.port_open) { $blocked += 'target_port_not_open' }
    if ($local.ok -ne $true) { $blocked += 'local_runtime_not_healthy' }
    if ($freshness.ok -eq $true) { $blocked += 'runtime_already_current' }
    if ($staleProof.Count -eq 0) { $blocked += 'missing_explicit_stale_proof' }

    $lastAt = $null
    if ($last -and $last.at) {
        try { $lastAt = [datetime]::Parse([string]$last.at).ToUniversalTime() } catch { $lastAt = $null }
    }
    $lastAgeSeconds = if ($lastAt) { [Math]::Round(((Get-Date).ToUniversalTime() - $lastAt).TotalSeconds, 3) } else { $null }
    if ($lastAgeSeconds -ne $null -and $lastAgeSeconds -lt $CooldownSeconds -and $freshness.ok -ne $true) {
        $blocked += 'cooldown_active_after_recent_replace'
    }

    $safe = [bool]($blocked.Count -eq 0)
    return [pscustomobject]@{
        ok = $safe
        status = if ($safe) { 'RUNTIME_REPLACE_PLAN_READY' } else { 'RUNTIME_REPLACE_PLAN_BLOCKED' }
        command = 'runtime-replace-stale'
        mode = $Mode
        will_stop_anything = $safe
        target_profiles = @($spec.Name)
        reason = if ($safe) { 'stale_runtime_proven' } else { 'precondition_blocked' }
        safe_to_execute = $safe
        stale_proof = @($staleProof)
        blocked_reasons = @($blocked | Sort-Object -Unique)
        cooldown_seconds = $CooldownSeconds
        last_replace_age_seconds = $lastAgeSeconds
        service = $service
        freshness = $freshness
        local = $local
        build_output = $build
        last_replace = $last
        next_action = if ($safe) { 'run runtime-replace-stale to replace only chatgpt-oauth' } else { 'do not stop runtime; inspect blocked_reasons' }
    }
}

function Assert-ConsoleDevRuntimeReplacePrerequisiteShape {
    param([Parameter(Mandatory = $true)]$Plan)
    $targets = @($Plan.target_profiles)
    if ($targets.Count -ne 1 -or $targets[0] -ne 'chatgpt-oauth') {
        throw 'Runtime replace plan must target only chatgpt-oauth.'
    }
    if ($Plan.safe_to_execute -eq $true -and @($Plan.stale_proof).Count -eq 0) {
        throw 'Runtime replace plan cannot execute without explicit stale proof.'
    }
    if ($Plan.safe_to_execute -eq $true -and $Plan.will_stop_anything -ne $true) {
        throw 'Executable runtime replace plan must disclose will_stop_anything=true.'
    }
    return $Plan
}

function Invoke-ConsoleDevRuntimeReplaceStale {
    $plan = Assert-ConsoleDevRuntimeReplacePrerequisiteShape -Plan (New-ConsoleDevRuntimeReplacePlan)
    if ($plan.safe_to_execute -ne $true) {
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_BLOCKED' -Ok $false -Plan $plan -Detail @{ blocked_reasons = $plan.blocked_reasons }
        return ($state | ConvertTo-Json -Depth 30)
    }

    Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_REPLACING' -Ok $false -Plan $plan | Out-Null
    try {
        $result = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'warm' -ExpectedTools @()
        $postcondition = Invoke-AuthRuntimePostcondition -Kind 'chatgpt'
        $ok = [bool]($postcondition.ok -eq $true)
        $replaceStatus = if ($ok) { 'RUNTIME_REPLACE_READY' } else { 'RUNTIME_REPLACE_POSTCONDITION_FAILED' }
        $state = Write-RuntimeReplaceState -Status $replaceStatus -Ok $ok -Plan $plan -Detail @{ restart = $result; postcondition = $postcondition }
        return ($state | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        $state = Write-RuntimeReplaceState -Status 'RUNTIME_REPLACE_FAILED' -Ok $false -Plan $plan -ErrorMessage $message
        return ($state | ConvertTo-Json -Depth 30)
    }
}

