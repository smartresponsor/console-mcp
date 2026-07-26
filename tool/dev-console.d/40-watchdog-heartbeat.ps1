function Get-WatchdogLoopHeartbeatMaxAgeSeconds {
    $configured = $env:CONSOLE_MCP_WATCHDOG_HEARTBEAT_MAX_AGE_SECONDS
    $parsed = 0
    if ($configured -and [int]::TryParse($configured, [ref]$parsed) -and $parsed -ge 5 -and $parsed -le 300) {
        return $parsed
    }
    return 300
}

function Get-WatchdogLoopHeartbeatState {
    param([object]$Loop = $null)
    if (-not $Loop) { $Loop = Get-WatchdogLoopProcessState }
    $maxAge = Get-WatchdogLoopHeartbeatMaxAgeSeconds
    $broker = $null
    try { $broker = Get-ServerControlBrokerIdentity } catch { $broker = $null }

    if (-not $broker -or [string]::IsNullOrWhiteSpace([string]$broker.heartbeat_at)) {
        return [pscustomobject]@{ ok = $false; status = 'HEARTBEAT_NEVER_OBSERVED'; age_seconds = $null; max_age_seconds = $maxAge; broker_pid = $null; broker_generation = $null; matches_loop_pid = $false; heartbeat_sequence = $null }
    }

    $ageSeconds = $null
    try {
        $heartbeatUtc = [datetime]::Parse(
            [string]$broker.heartbeat_at,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
        )
        $ageSeconds = [Math]::Round(((Get-Date).ToUniversalTime() - $heartbeatUtc).TotalSeconds, 3)
    } catch {
        $ageSeconds = $null
    }
    $matchesLoopPid = [bool]($Loop -and $Loop.pid -and $broker.pid -and [int]$broker.pid -eq [int]$Loop.pid)
    $fresh = [bool]($ageSeconds -ne $null -and $ageSeconds -ge 0 -and $ageSeconds -le $maxAge)

    return [pscustomobject]@{
        ok = [bool]($fresh -and $matchesLoopPid)
        status = if (-not $matchesLoopPid) { 'HEARTBEAT_PID_MISMATCH' } elseif ($fresh) { 'HEARTBEAT_FRESH' } else { 'HEARTBEAT_STALE' }
        age_seconds = $ageSeconds
        max_age_seconds = $maxAge
        broker_pid = $broker.pid
        broker_generation = $broker.generation
        matches_loop_pid = $matchesLoopPid
        heartbeat_sequence = $broker.heartbeat_sequence
    }
}

