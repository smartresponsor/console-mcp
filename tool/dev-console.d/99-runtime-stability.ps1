# Lightweight, non-repairing runtime stability observation.
# This module deliberately consumes existing durable telemetry instead of re-running expensive collectors.

function Get-RuntimeStabilityPreviousState {
    if (-not (Test-Path -LiteralPath $RuntimeStabilityStateFile -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $RuntimeStabilityStateFile -Raw | ConvertFrom-Json -Depth 30 } catch { return $null }
}

function Invoke-RuntimeStabilityHttpProbe {
    param([Parameter(Mandatory = $true)][string]$Uri, [int]$TimeoutSeconds = 2)
    $started = Get-Date
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec $TimeoutSeconds -MaximumRedirection 0 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{ ok=$true; status_code=[int]$response.StatusCode; elapsed_ms=[Math]::Round(((Get-Date)-$started).TotalMilliseconds,1); error=$null }
    } catch {
        return [pscustomobject]@{ ok=$false; status_code=$null; elapsed_ms=[Math]::Round(((Get-Date)-$started).TotalMilliseconds,1); error=Sanitize-Text $_.Exception.Message }
    }
}

function Convert-RuntimeStabilityTimestampUtc {
    param([Parameter(Mandatory = $true)]$Value)
    if ($Value -is [datetimeoffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [datetime]) { return [datetimeoffset]::new($Value.ToUniversalTime()) }
    return [datetimeoffset]::Parse([string]$Value).ToUniversalTime()
}

function Get-RuntimeStabilityProtocolSummary {
    $cadence = Get-WatchdogCadenceState
    $localAuth = $null
    try { $localAuth = $cadence.lanes.local_auth } catch { $localAuth = $null }
    if (-not $localAuth -or [string]::IsNullOrWhiteSpace([string]$localAuth.completed_at)) {
        return [pscustomobject]@{ available=$false; stale=$true; age_seconds=$null; ok=$false; status='LOCAL_AUTH_MISSING' }
    }
    try {
        $completedValue = $localAuth.completed_at
        $completedAt = Convert-RuntimeStabilityTimestampUtc -Value $completedValue
        $nowUtc = [datetimeoffset]::UtcNow
        $age = [Math]::Round(($nowUtc.UtcDateTime - $completedAt.UtcDateTime).TotalSeconds,1)
        $futureTimestamp = $age -lt -5
        return [pscustomobject]@{
            available=$true
            stale=[bool]($futureTimestamp -or $age -gt 45)
            age_seconds=$age
            ok=[bool](-not $futureTimestamp -and $localAuth.ok -eq $true)
            status=if($futureTimestamp){'LOCAL_AUTH_FUTURE_TIMESTAMP'}else{[string]$localAuth.status}
        }
    } catch {
        return [pscustomobject]@{ available=$false; stale=$true; age_seconds=$null; ok=$false; status='LOCAL_AUTH_INVALID' }
    }
}

function Get-RuntimeStabilityEnvironmentSummary {
    if (-not (Test-Path -LiteralPath $RuntimeEnvironmentStateFile -PathType Leaf)) {
        return [pscustomobject]@{ available=$false; stale=$true; age_seconds=$null; resource_pressure=$null; engine_execution_pressure=$null }
    }
    try {
        $environment = Get-Content -LiteralPath $RuntimeEnvironmentStateFile -Raw | ConvertFrom-Json -Depth 30
        $sampledAt = Convert-RuntimeStabilityTimestampUtc -Value $environment.sampled_at
        $age = [Math]::Round(([datetimeoffset]::UtcNow - $sampledAt).TotalSeconds,1)
        return [pscustomobject]@{
            available=$true
            stale=[bool]($age -gt 180)
            age_seconds=$age
            resource_pressure=$environment.resource_pressure
            engine_execution_pressure=$environment.engine_execution_pressure
        }
    } catch {
        return [pscustomobject]@{ available=$false; stale=$true; age_seconds=$null; resource_pressure=$null; engine_execution_pressure=$null }
    }
}

function Write-RuntimeFailureLedgerEvent {
    param([Parameter(Mandatory = $true)][string]$Event, [Parameter(Mandatory = $true)][string]$FailureClass, [Parameter(Mandatory = $true)]$Snapshot)
    $record = [pscustomobject]@{
        schema_version = 1
        timestamp = [datetimeoffset]::UtcNow.ToString('o')
        event = $Event
        failure_class = $FailureClass
        watchdog_pid = $PID
        console_mcp_pid = $Snapshot.console_mcp_pid
        chatgpt_http = $Snapshot.chatgpt_http
        codex_http = $Snapshot.codex_http
        cdp = $Snapshot.cdp
        resource_pressure = $Snapshot.environment.resource_pressure
        engine_execution_pressure = $Snapshot.environment.engine_execution_pressure
    }
    Add-Content -LiteralPath $RuntimeFailureLedgerFile -Value ($record | ConvertTo-Json -Depth 12 -Compress) -Encoding utf8
}

function Get-RuntimeFailureRecentSummary {
    param([int]$MaxEvents = 200)
    if (-not (Test-Path -LiteralPath $RuntimeFailureLedgerFile -PathType Leaf)) {
        return [pscustomobject]@{
            event_count = 0
            failures_5m = 0
            failures_15m = 0
            failures_60m = 0
            recent_failure_intervals_seconds = @()
            interval_trend = 'INSUFFICIENT_DATA'
            stability = 'NORMAL'
        }
    }

    $now = [datetimeoffset]::UtcNow
    $events = [System.Collections.Generic.List[object]]::new()
    foreach ($line in @(Get-Content -LiteralPath $RuntimeFailureLedgerFile -Tail $MaxEvents -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $events.Add(($line | ConvertFrom-Json -Depth 20)) | Out-Null } catch { }
    }

    $failures = @($events | Where-Object { $_.event -eq 'failure_started' } | ForEach-Object {
        try {
            $timestamp = Convert-RuntimeStabilityTimestampUtc -Value $_.timestamp
            [pscustomobject]@{ timestamp = $timestamp; age_seconds = ($now - $timestamp).TotalSeconds; failure_class = [string]$_.failure_class }
        } catch { }
    } | Where-Object { $null -ne $_ } | Sort-Object timestamp)

    $recentFailures = @($failures | Select-Object -Last 6)
    $intervals = [System.Collections.Generic.List[double]]::new()
    for ($index = 1; $index -lt $recentFailures.Count; $index++) {
        $intervals.Add([Math]::Round(($recentFailures[$index].timestamp - $recentFailures[$index - 1].timestamp).TotalSeconds, 1)) | Out-Null
    }

    # Multiple failure classes commonly start in the same probe sample (for example ChatGPT,
    # Codex, and process-exit signals during one runtime outage). Keep the raw class-event counts
    # for diagnostics, but group starts within a short burst into one operational incident so
    # correlated symptoms do not multiply the stability penalty.
    $incidents = [System.Collections.Generic.List[object]]::new()
    foreach ($failure in $failures) {
        $lastIncident = if ($incidents.Count -gt 0) { $incidents[$incidents.Count - 1] } else { $null }
        if (-not $lastIncident -or ($failure.timestamp - $lastIncident.timestamp).TotalSeconds -gt 5) {
            $incidents.Add([pscustomobject]@{
                timestamp = $failure.timestamp
                age_seconds = $failure.age_seconds
                failure_classes = [System.Collections.Generic.List[string]]::new()
            }) | Out-Null
            $lastIncident = $incidents[$incidents.Count - 1]
        }
        $lastIncident.failure_classes.Add([string]$failure.failure_class) | Out-Null
    }

    $recentIncidents = @($incidents | Select-Object -Last 6)
    $incidentIntervals = [System.Collections.Generic.List[double]]::new()
    for ($index = 1; $index -lt $recentIncidents.Count; $index++) {
        $incidentIntervals.Add([Math]::Round(($recentIncidents[$index].timestamp - $recentIncidents[$index - 1].timestamp).TotalSeconds, 1)) | Out-Null
    }

    $trend = 'INSUFFICIENT_DATA'
    if ($incidentIntervals.Count -ge 3) {
        $lastThree = @($incidentIntervals | Select-Object -Last 3)
        if ($lastThree[0] -gt $lastThree[1] -and $lastThree[1] -gt $lastThree[2]) { $trend = 'SHRINKING' }
        elseif ($lastThree[0] -lt $lastThree[1] -and $lastThree[1] -lt $lastThree[2]) { $trend = 'EXPANDING' }
        else { $trend = 'MIXED' }
    }

    $failures5m = @($failures | Where-Object { $_.age_seconds -le 300 }).Count
    $failures15m = @($failures | Where-Object { $_.age_seconds -le 900 }).Count
    $failures60m = @($failures | Where-Object { $_.age_seconds -le 3600 }).Count
    $incidents5m = @($incidents | Where-Object { $_.age_seconds -le 300 }).Count
    $incidents15m = @($incidents | Where-Object { $_.age_seconds -le 900 }).Count
    $incidents60m = @($incidents | Where-Object { $_.age_seconds -le 3600 }).Count
    $stability = if ($incidents5m -ge 3 -or $trend -eq 'SHRINKING' -and $incidents15m -ge 3) {
        'CRITICAL'
    } elseif ($incidents15m -ge 3) {
        'UNSTABLE'
    } elseif ($incidents5m -eq 0 -and $incidents15m -le 1 -and $incidents60m -gt 0) {
        'RECOVERING'
    } elseif ($incidents60m -gt 0) {
        'DEGRADED'
    } else {
        'NORMAL'
    }

    return [pscustomobject]@{
        event_count = [int]$events.Count
        failures_5m = [int]$failures5m
        failures_15m = [int]$failures15m
        failures_60m = [int]$failures60m
        incidents_5m = [int]$incidents5m
        incidents_15m = [int]$incidents15m
        incidents_60m = [int]$incidents60m
        recent_failure_intervals_seconds = @($intervals)
        recent_incident_intervals_seconds = @($incidentIntervals)
        interval_trend = $trend
        stability = $stability
    }
}

function Invoke-RuntimeStabilityObservation {
    $previous = Get-RuntimeStabilityPreviousState
    $consolePid = $null
    if (Test-Path -LiteralPath $UnifiedPidFile -PathType Leaf) { try { $consolePid = [int](Get-Content -LiteralPath $UnifiedPidFile -Raw).Trim() } catch { $consolePid = $null } }
    $processAlive = [bool]($consolePid -and (Get-Process -Id $consolePid -ErrorAction SilentlyContinue))
    $chatgpt = Invoke-RuntimeStabilityHttpProbe -Uri $ChatgptOrigin
    $codex = Invoke-RuntimeStabilityHttpProbe -Uri $CodexOrigin
    $cdp = Invoke-RuntimeStabilityHttpProbe -Uri "http://127.0.0.1:$RequiredBrowserDevToolsPort/json/version"
    $environment = Get-RuntimeStabilityEnvironmentSummary
    $protocol = Get-RuntimeStabilityProtocolSummary
    $broker = Get-ServerControlBrokerIdentity
    $brokerPid = if ($broker -and $broker.pid) { [int]$broker.pid } else { $null }
    $watchdogOwnershipConsistent = [bool]($brokerPid -and $brokerPid -eq $PID)

    $failureClasses = [System.Collections.Generic.List[string]]::new()
    if (-not $watchdogOwnershipConsistent) { $failureClasses.Add('WATCHDOG_OWNERSHIP_MISMATCH') | Out-Null }
    if (-not $processAlive) { $failureClasses.Add('MCP_PROCESS_EXIT') | Out-Null }
    if (-not $chatgpt.ok) { $failureClasses.Add('MCP_CHATGPT_ENDPOINT_UNRESPONSIVE') | Out-Null }
    if (-not $codex.ok) { $failureClasses.Add('MCP_CODEX_ENDPOINT_UNRESPONSIVE') | Out-Null }
    if (-not $cdp.ok) { $failureClasses.Add('CDP_UNRESPONSIVE') | Out-Null }
    if (-not $protocol.ok) { $failureClasses.Add('MCP_PROTOCOL_UNRESPONSIVE') | Out-Null }
    elseif ($protocol.stale) { $failureClasses.Add('MCP_PROTOCOL_SMOKE_STALE') | Out-Null }
    if ($environment.stale) { $failureClasses.Add('RESOURCE_TELEMETRY_STALE') | Out-Null }

    $previousClasses = @()
    if ($previous -and $previous.current_failure_classes) { $previousClasses = @($previous.current_failure_classes | ForEach-Object { [string]$_ }) }
    $currentClasses = @($failureClasses | Sort-Object -Unique)
    $newFailures = @($currentClasses | Where-Object { $previousClasses -notcontains $_ })
    $recoveries = @($previousClasses | Where-Object { $currentClasses -notcontains $_ })

    $snapshot = [pscustomobject]@{
        schema_version = 1
        sampled_at = [datetimeoffset]::UtcNow.ToString('o')
        watchdog_pid = $PID
        broker_pid = $brokerPid
        watchdog_ownership_consistent = $watchdogOwnershipConsistent
        console_mcp_pid = $consolePid
        console_mcp_alive = $processAlive
        chatgpt_http = $chatgpt
        codex_http = $codex
        cdp = $cdp
        protocol = $protocol
        environment = $environment
        recent = $null
        current_failure_classes = $currentClasses
        consecutive_failure_samples = if ($currentClasses.Count -gt 0) { if ($previous) { [int]$previous.consecutive_failure_samples + 1 } else { 1 } } else { 0 }
        last_failure_at = if ($newFailures.Count -gt 0) { [datetimeoffset]::UtcNow.ToString('o') } elseif ($previous) { $previous.last_failure_at } else { $null }
        last_recovery_at = if ($recoveries.Count -gt 0) { [datetimeoffset]::UtcNow.ToString('o') } elseif ($previous) { $previous.last_recovery_at } else { $null }
    }

    foreach ($failureClass in $newFailures) { Write-RuntimeFailureLedgerEvent -Event 'failure_started' -FailureClass $failureClass -Snapshot $snapshot }
    foreach ($failureClass in $recoveries) { Write-RuntimeFailureLedgerEvent -Event 'failure_recovered' -FailureClass $failureClass -Snapshot $snapshot }
    $snapshot.recent = Get-RuntimeFailureRecentSummary

    $temporary = "$RuntimeStabilityStateFile.$PID.tmp"
    $snapshot | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $RuntimeStabilityStateFile -Force
    return $snapshot
}

Register-WatchdogCadenceLane -Name 'runtime_stability' -IntervalSeconds 10 -InsertBefore 'build_fingerprint' -Invoke {
    $snapshot = Invoke-RuntimeStabilityObservation
    [pscustomobject]@{
        ok = [bool]($snapshot.current_failure_classes.Count -eq 0)
        status = if ($snapshot.current_failure_classes.Count -eq 0) { 'RUNTIME_STABILITY_HEALTHY' } else { 'RUNTIME_STABILITY_DEGRADED' }
        repair_required = $false
        detail = [pscustomobject]@{
            sampled_at = $snapshot.sampled_at
            console_mcp_pid = $snapshot.console_mcp_pid
            failure_classes = $snapshot.current_failure_classes
            consecutive_failure_samples = $snapshot.consecutive_failure_samples
            resource_pressure = $snapshot.environment.resource_pressure
        }
    }
}
