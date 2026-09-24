$script:WatchdogCadenceExtensionRegistry = [ordered]@{}

function Register-WatchdogCadenceLane {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]*$')][string]$Name,
        [Parameter(Mandatory = $true)][ValidateRange(1, 86400)][int]$IntervalSeconds,
        [Parameter(Mandatory = $true)][scriptblock]$Invoke,
        [scriptblock]$IsDue = $null,
        [string]$InsertBefore = 'build_fingerprint'
    )

    $baseNames = @('runtime','local_auth','browser','public_tunnel','visual_gallery','task_integrity','build_fingerprint')
    if ($baseNames -contains $Name -or $script:WatchdogCadenceExtensionRegistry.Contains($Name)) {
        throw "Watchdog cadence lane is already registered: $Name"
    }
    $script:WatchdogCadenceExtensionRegistry[$Name] = [pscustomobject]@{
        name = $Name
        interval_seconds = $IntervalSeconds
        invoke = $Invoke
        is_due = $IsDue
        insert_before = $InsertBefore
    }
}

function Get-WatchdogCadenceDefinition {
    $base = [ordered]@{
        runtime = 5
        local_auth = 30
        browser = 60
        public_tunnel = 120
        visual_gallery = 30
        task_integrity = 300
        build_fingerprint = 600
    }
    if ($script:WatchdogCadenceExtensionRegistry.Count -eq 0) { return $base }

    $definition = [ordered]@{}
    foreach ($entry in $base.GetEnumerator()) {
        foreach ($extension in $script:WatchdogCadenceExtensionRegistry.Values) {
            if ($extension.insert_before -eq $entry.Key) {
                $definition[$extension.name] = [int]$extension.interval_seconds
            }
        }
        $definition[$entry.Key] = $entry.Value
    }
    foreach ($extension in $script:WatchdogCadenceExtensionRegistry.Values) {
        if (-not $definition.Contains($extension.name)) { $definition[$extension.name] = [int]$extension.interval_seconds }
    }
    return $definition
}

function Get-WatchdogCadenceState {
    if (-not (Test-Path -LiteralPath $WatchdogCadenceStateFile -PathType Leaf)) {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null; repair_not_before = $null }
    }
    try { return Get-Content -LiteralPath $WatchdogCadenceStateFile -Raw | ConvertFrom-Json -Depth 30 } catch {
        return [pscustomobject]@{ schema_version = 1; lanes = [pscustomobject]@{}; last_repair_at = $null; repair_not_before = $null }
    }
}

function Convert-WatchdogCadenceTimestampUtc {
    param([Parameter(Mandatory = $true)]$Value)
    if ($Value -is [datetimeoffset]) { return $Value.ToUniversalTime().UtcDateTime }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    return [datetimeoffset]::Parse([string]$Value).UtcDateTime
}

function Set-WatchdogRepairDeferral {
    param(
        [ValidateRange(0, 300)][int]$Seconds = 30,
        [string]$Reason = 'unspecified'
    )
    $state = Get-WatchdogCadenceState
    $notBefore = (Get-Date).ToUniversalTime().AddSeconds($Seconds).ToString('o')
    $state | Add-Member -NotePropertyName repair_not_before -NotePropertyValue $notBefore -Force
    $state | Add-Member -NotePropertyName repair_deferral_reason -NotePropertyValue $Reason -Force
    Write-WatchdogCadenceState -State $state
    return [pscustomobject]@{
        repair_not_before = $notBefore
        repair_deferral_seconds = $Seconds
        repair_deferral_reason = $Reason
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
    if ($script:WatchdogCadenceExtensionRegistry.Contains($Name)) {
        $extension = $script:WatchdogCadenceExtensionRegistry[$Name]
        if ($extension.is_due -and (& $extension.is_due -State $State -Now $Now)) { return $true }
    }
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
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($script:WatchdogCadenceExtensionRegistry.Contains($Name)) {
        try { return & $script:WatchdogCadenceExtensionRegistry[$Name].invoke }
        catch {
            return [pscustomobject]@{ ok=$false; status='CADENCE_LANE_FAILED'; repair_required=$false; detail=[pscustomobject]@{lane=$Name;error=Sanitize-Text $_.Exception.Message;script_stack_trace=Sanitize-Text ([string]$_.ScriptStackTrace)} }
        }
    }
    if (@('runtime','local_auth','browser','public_tunnel','visual_gallery','task_integrity','build_fingerprint') -notcontains $Name) {
        throw "Unknown watchdog cadence lane: $Name"
    }
    try {
        switch ($Name) {
            'runtime' {
                $chatgpt = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
                $codex = Get-ManagedProcessState -Spec (Get-CodexSpec)
                $tunnel = Get-ManagedProcessState -Spec (Get-TunnelSpec)
                $runtimeFresh = [bool]($chatgpt.runtime_state -ne 'stale' -and $codex.runtime_state -ne 'stale')
                $ok = [bool]($chatgpt.running -and $chatgpt.port_open -and $codex.running -and $codex.port_open -and $tunnel.running -and $runtimeFresh)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'RUNTIME_LIGHTWEIGHT_HEALTHY'}else{'RUNTIME_LIGHTWEIGHT_UNHEALTHY'}; repair_required=(-not $ok); detail=[pscustomobject]@{chatgpt=$chatgpt;codex=$codex;tunnel=$tunnel;runtime_fresh=$runtimeFresh} }
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
            'visual_gallery' {
                $gallery = Invoke-VisualGalleryHealthProbe
                $ok = [bool]($gallery.ok -eq $true)
                return [pscustomobject]@{ ok=$ok; status=if($ok){'VISUAL_GALLERY_HEALTHY'}else{'VISUAL_GALLERY_UNHEALTHY'}; repair_required=(-not $ok); detail=$gallery }
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
    if (-not [string]::IsNullOrWhiteSpace([string]$State.repair_not_before)) {
        try {
            $existingRepairNotBefore = [datetimeoffset]::Parse([string]$State.repair_not_before).UtcDateTime
            if ((Get-Date).ToUniversalTime() -ge $existingRepairNotBefore) {
                $State | Add-Member -NotePropertyName repair_not_before -NotePropertyValue $null -Force
                $State | Add-Member -NotePropertyName repair_deferral_reason -NotePropertyValue $null -Force
            }
        } catch {
            $State | Add-Member -NotePropertyName repair_not_before -NotePropertyValue $null -Force
            $State | Add-Member -NotePropertyName repair_deferral_reason -NotePropertyValue $null -Force
        }
    }
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
    $repairDeferred = $false
    $repairDeferredUntil = $null
    if ($repairRequired) {
        $repairDue = $true
        if (-not [string]::IsNullOrWhiteSpace([string]$State.repair_not_before)) {
            try {
                $repairDeferredUntil = Convert-WatchdogCadenceTimestampUtc -Value $State.repair_not_before
                $repairDeferred = (Get-Date).ToUniversalTime() -lt $repairDeferredUntil
                if ($repairDeferred) { $repairDue = $false }
                else {
                    $State | Add-Member -NotePropertyName repair_not_before -NotePropertyValue $null -Force
                    $State | Add-Member -NotePropertyName repair_deferral_reason -NotePropertyValue $null -Force
                }
            } catch {
                $State | Add-Member -NotePropertyName repair_not_before -NotePropertyValue $null -Force
                $State | Add-Member -NotePropertyName repair_deferral_reason -NotePropertyValue $null -Force
            }
        }
        if ($repairDue -and -not [string]::IsNullOrWhiteSpace([string]$State.last_repair_at)) {
            try { $lastRepairAt = Convert-WatchdogCadenceTimestampUtc -Value $State.last_repair_at; $repairDue = ((Get-Date).ToUniversalTime() - $lastRepairAt).TotalSeconds -ge 30 } catch { $repairDue = $true }
        }
        if ($repairDue) {
            $repair = Invoke-WatchdogHeal | ConvertFrom-Json
            $State.last_repair_at = (Get-Date).ToUniversalTime().ToString('o')
            $State.repair_not_before = $null
            $State.repair_deferral_reason = $null
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
    return [pscustomobject]@{ ok=[bool](-not $repairRequired -or $repairEffective); status=if($repairRequired){if($repairEffective){'CADENCE_REPAIR_COMPLETED'}elseif($repair -and $repair.ok -and $repair.repair_verified_by_lane -eq $false){'CADENCE_REPAIR_UNVERIFIED_BY_LANE'}elseif($repair){'CADENCE_REPAIR_FAILED'}elseif($repairDeferred){'CADENCE_REPAIR_DEFERRED'}else{'CADENCE_REPAIR_COOLDOWN'}}else{'CADENCE_HEALTHY'}; executed=@($executed); repair=$repair; repair_deferred=$repairDeferred; repair_not_before=if($repairDeferredUntil){$repairDeferredUntil.ToString('o')}else{$null}; repair_deferral_reason=if($repairDeferred){$State.repair_deferral_reason}else{$null}; connector_refresh_resolution=$connectorRefreshResolution; state=$State }
}

