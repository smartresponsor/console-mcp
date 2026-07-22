function Get-WatchdogCadenceDefinition {
    return [ordered]@{
        runtime = 5
        local_auth = 30
        browser = 60
        public_tunnel = 120
        task_integrity = 300
        build_fingerprint = 600
    }
}

function Get-WatchdogCadenceState {
    if (-not (Test-Path -LiteralPath $WatchdogCadenceStateFile -PathType Leaf)) {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null }
    }
    try { return Get-Content -LiteralPath $WatchdogCadenceStateFile -Raw | ConvertFrom-Json -Depth 30 } catch {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null }
    }
}

function Write-WatchdogCadenceState {
    param([Parameter(Mandatory = $true)]$State)
    $temporary = "$WatchdogCadenceStateFile.$PID.tmp"
    $State | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $WatchdogCadenceStateFile -Force
}

function Test-WatchdogCadenceLaneDue {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][int]$IntervalSeconds, [datetime]$Now = (Get-Date))
    $lane = $null
    try { $lane = $State.lanes.$Name } catch { $lane = $null }
    if (-not $lane -or [string]::IsNullOrWhiteSpace([string]$lane.completed_at)) { return $true }
    try { $completedAt = if ($lane.completed_at -is [datetime]) { $lane.completed_at.ToUniversalTime() } else { [datetimeoffset]::Parse([string]$lane.completed_at).UtcDateTime }; return ($Now.ToUniversalTime() - $completedAt).TotalSeconds -ge $IntervalSeconds } catch { return $true }
}

function Set-WatchdogCadenceLaneResult {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][int]$IntervalSeconds, [Parameter(Mandatory = $true)]$Result)
    $laneMap = [ordered]@{}
    foreach ($property in @($State.lanes.PSObject.Properties)) { $laneMap[$property.Name] = $property.Value }
    $laneMap[$Name] = [pscustomobject]@{
        interval_seconds = $IntervalSeconds
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
        ok = [bool]$Result.ok
        status = [string]$Result.status
        repair_required = [bool]$Result.repair_required
        detail = $Result.detail
    }
    $State.lanes = [pscustomobject]$laneMap
    return $State
}

function Invoke-WatchdogCadenceLane {
    param([Parameter(Mandatory = $true)][ValidateSet('runtime','local_auth','browser','public_tunnel','task_integrity','build_fingerprint')][string]$Name)
    try {
        switch ($Name) {
            'runtime' {
                $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
                $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
                $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
                $ok = [bool]($chatgpt.running -and $chatgpt.port_open -and $codex.running -and $codex.port_open -and $tunnel.running)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'RUNTIME_LIGHTWEIGHT_HEALTHY'}else{'RUNTIME_LIGHTWEIGHT_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{chatgpt=$chatgpt;codex=$codex;tunnel=$tunnel} }
            }
            'local_auth' {
                $chatgpt = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
                $codex = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
                $ok = [bool]($chatgpt.ok -eq $true -and $codex.ok -eq $true)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'LOCAL_AUTH_HEALTHY'}else{'LOCAL_AUTH_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{chatgpt=$chatgpt;codex=$codex} }
            }
            'browser' {
                $browser = Get-BrowserStackHealthReport
                $lease = Get-InteractiveDesktopCapabilityLease
                $ok = [bool]($browser.ok -and $lease.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'BROWSER_WARMTH_HEALTHY'}else{'BROWSER_WARMTH_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{browser=$browser;lease=$lease} }
            }
            'public_tunnel' {
                $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
                $ok = [bool]($public.ok -eq $true)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'PUBLIC_TUNNEL_HEALTHY'}else{'PUBLIC_TUNNEL_UNHEALTHY'}; repair_required=(-not $ok); detail=$public }
            }
            'task_integrity' {
                $task = Show-WatchdogTask
                $autologon = Get-AutologonReport
                $console = Get-ConsoleSessionReport
                $taskOk = [bool]($task.exists -and $task.declaration -and $task.declaration.ok)
                $ok = [bool]($taskOk -and $autologon.ok -and $console.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'TASK_AND_SESSION_INTEGRITY_HEALTHY'}else{'TASK_AND_SESSION_INTEGRITY_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{task=$task;autologon=$autologon;console_session=$console} }
            }
            'build_fingerprint' {
                $build = Get-BuildOutputReport
                $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
                $freshness = Get-ChatgptRuntimeFreshness
                $ok = [bool]($build.build_current -and $freshness.ok)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'BUILD_FINGERPRINT_HEALTHY'}else{'BUILD_FINGERPRINT_STALE'}; repair_required=(-not $ok); detail=[pscustomobject]@{build=$build;runtime_freshness=$freshness} }
            }
        }
    } catch {
        return [pscustomobject]@{ ok=$false; status='CADENCE_LANE_FAILED'; repair_required=$true; detail=[pscustomobject]@{lane=$Name;error=Sanitize-Text $_.Exception.Message;script_stack_trace=Sanitize-Text ([string]$_.ScriptStackTrace)} }
    }
}

function Invoke-WatchdogCadenceScheduler {
    param([object]$State = $null)
    if (-not $State) { $State = Get-WatchdogCadenceState }
    $connectorRefreshResolution = Resolve-PendingChatgptConnectorRefresh
    $definition = Get-WatchdogCadenceDefinition
    $executed = [System.Collections.Generic.List[object]]::new()
    $repairRequired = $false
    $slowLaneExecuted = $false
    foreach ($entry in $definition.GetEnumerator()) {
        if (-not (Test-WatchdogCadenceLaneDue -State $State -Name $entry.Key -IntervalSeconds ([int]$entry.Value))) { continue }
        # Never burst all slow probes after a fresh install, state-file loss, or long suspension.
        # The 5-second runtime lane may run alongside one slow lane; all remaining slow lanes are
        # deferred to subsequent one-second broker ticks.
        if ($entry.Key -ne 'runtime' -and $slowLaneExecuted) { continue }
        $result = Invoke-WatchdogCadenceLane -Name $entry.Key
        $State = Set-WatchdogCadenceLaneResult -State $State -Name $entry.Key -IntervalSeconds ([int]$entry.Value) -Result $result
        $executed.Add([pscustomobject]@{ name=$entry.Key; interval_seconds=[int]$entry.Value; result=$result }) | Out-Null
        if ($entry.Key -ne 'runtime') { $slowLaneExecuted = $true }
        if ($result.repair_required) { $repairRequired = $true }
    }

    $repair = $null
    if ($repairRequired) {
        $repairDue = $true
        if (-not [string]::IsNullOrWhiteSpace([string]$State.last_repair_at)) {
            try { $lastRepairAt = if ($State.last_repair_at -is [datetime]) { $State.last_repair_at.ToUniversalTime() } else { [datetimeoffset]::Parse([string]$State.last_repair_at).UtcDateTime }; $repairDue = ((Get-Date).ToUniversalTime() - $lastRepairAt).TotalSeconds -ge 30 } catch { $repairDue = $true }
        }
        if ($repairDue) {
            $repair = Invoke-WatchdogHeal | ConvertFrom-Json
            $State.last_repair_at = (Get-Date).ToUniversalTime().ToString('o')
            # The cadence lanes and Invoke-WatchdogHeal are two independently-maintained definitions
            # of "healthy" - trusting repair.ok alone as proof the failing lane(s) are actually fixed
            # risks exactly the kind of silent drift that happens when the same concept is judged in
            # two places that can be edited separately. Re-check only the lane(s) that triggered this
            # repair, using the SAME lane check that flagged them broken, and record whether that
            # check now agrees - rather than papering over any disagreement with a global heal.ok.
            $recheckedLanes = [System.Collections.Generic.List[object]]::new()
            foreach ($entry in $executed) {
                if (-not $entry.result.repair_required) { continue }
                $recheck = Invoke-WatchdogCadenceLane -Name $entry.name
                $State = Set-WatchdogCadenceLaneResult -State $State -Name $entry.name -IntervalSeconds $entry.interval_seconds -Result $recheck
                $recheckedLanes.Add([pscustomobject]@{ name = $entry.name; ok = [bool]$recheck.ok; status = [string]$recheck.status }) | Out-Null
            }
            $repairVerifiedByLane = [bool](-not (@($recheckedLanes) | Where-Object { $_.ok -ne $true }))
            $repair | Add-Member -NotePropertyName rechecked_lanes -NotePropertyValue @($recheckedLanes) -Force
            $repair | Add-Member -NotePropertyName repair_verified_by_lane -NotePropertyValue $repairVerifiedByLane -Force
        }
    }
    Write-WatchdogCadenceState -State $State
    $repairEffective = [bool]($repair -and $repair.ok -and $repair.repair_verified_by_lane -ne $false)
    return [pscustomobject]@{ ok=[bool](-not $repairRequired -or $repairEffective); status=if($repairRequired){if($repairEffective){'CADENCE_REPAIR_COMPLETED'}elseif($repair -and $repair.ok -and $repair.repair_verified_by_lane -eq $false){'CADENCE_REPAIR_UNVERIFIED_BY_LANE'}elseif($repair){'CADENCE_REPAIR_FAILED'}else{'CADENCE_REPAIR_COOLDOWN'}}else{'CADENCE_HEALTHY'}; executed=@($executed); repair=$repair; connector_refresh_resolution=$connectorRefreshResolution; state=$State }
}

