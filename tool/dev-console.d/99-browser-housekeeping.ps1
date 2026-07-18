# Periodic browser housekeeping extension for the watchdog cadence scheduler.
# Loaded after the canonical watchdog module so existing cadence behavior remains authoritative
# and this module adds one non-repair lane without duplicating the scheduler itself.

$BrowserHousekeepingStateFile = Join-Path $RunDir 'chatgpt-plugin-settings-housekeeping.json'

$script:BrowserHousekeepingBaseGetCadenceDefinition = ${function:Get-WatchdogCadenceDefinition}
$script:BrowserHousekeepingBaseTestLaneDue = ${function:Test-WatchdogCadenceLaneDue}
$script:BrowserHousekeepingBaseInvokeLane = ${function:Invoke-WatchdogCadenceLane}

function Get-BrowserHousekeepingIntervalSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_BROWSER_HOUSEKEEPING_INTERVAL_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_BROWSER_HOUSEKEEPING_INTERVAL_SECONDS, [ref]$configured) -and $configured -ge 60 -and $configured -le 86400) {
        return $configured
    }
    return 600
}

function Get-BrowserHousekeepingRefreshGraceSeconds {
    $configured = 0
    if ($env:CONSOLE_MCP_BROWSER_HOUSEKEEPING_REFRESH_GRACE_SECONDS -and [int]::TryParse($env:CONSOLE_MCP_BROWSER_HOUSEKEEPING_REFRESH_GRACE_SECONDS, [ref]$configured) -and $configured -ge 0 -and $configured -le 3600) {
        return $configured
    }
    return 60
}

function Get-WatchdogCadenceDefinition {
    $base = & $script:BrowserHousekeepingBaseGetCadenceDefinition
    $extended = [ordered]@{}
    foreach ($entry in $base.GetEnumerator()) {
        if ($entry.Key -eq 'build_fingerprint') {
            $extended['browser_housekeeping'] = Get-BrowserHousekeepingIntervalSeconds
        }
        $extended[$entry.Key] = $entry.Value
    }
    if (-not $extended.Contains('browser_housekeeping')) {
        $extended['browser_housekeeping'] = Get-BrowserHousekeepingIntervalSeconds
    }
    return $extended
}

function Get-BrowserHousekeepingRefreshDueState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [datetime]$Now = (Get-Date)
    )

    $refresh = $null
    try { $refresh = Get-ChatgptConnectorRefreshState } catch { $refresh = $null }
    if (-not $refresh -or [string]::IsNullOrWhiteSpace([string]$refresh.at)) {
        return [pscustomobject]@{ due = $false; reason = 'connector_refresh_not_observed'; refresh_at = $null; lane_completed_at = $null; grace_seconds = Get-BrowserHousekeepingRefreshGraceSeconds }
    }

    $refreshAt = $null
    try { $refreshAt = [datetimeoffset]::Parse([string]$refresh.at).UtcDateTime } catch { $refreshAt = $null }
    if (-not $refreshAt) {
        return [pscustomobject]@{ due = $false; reason = 'connector_refresh_timestamp_invalid'; refresh_at = [string]$refresh.at; lane_completed_at = $null; grace_seconds = Get-BrowserHousekeepingRefreshGraceSeconds }
    }

    $lane = $null
    try { $lane = $State.lanes.browser_housekeeping } catch { $lane = $null }
    $completedAt = $null
    if ($lane -and -not [string]::IsNullOrWhiteSpace([string]$lane.completed_at)) {
        try { $completedAt = [datetimeoffset]::Parse([string]$lane.completed_at).UtcDateTime } catch { $completedAt = $null }
    }

    $graceSeconds = Get-BrowserHousekeepingRefreshGraceSeconds
    $graceElapsed = ($Now.ToUniversalTime() - $refreshAt).TotalSeconds -ge $graceSeconds
    $refreshNotHandled = (-not $completedAt) -or $completedAt -lt $refreshAt
    return [pscustomobject]@{
        due = [bool]($graceElapsed -and $refreshNotHandled)
        reason = if (-not $graceElapsed) { 'connector_refresh_grace_pending' } elseif ($refreshNotHandled) { 'connector_refresh_handoff_due' } else { 'connector_refresh_already_handled' }
        refresh_at = $refreshAt.ToString('o')
        lane_completed_at = if ($completedAt) { $completedAt.ToString('o') } else { $null }
        grace_seconds = $graceSeconds
    }
}

function Test-WatchdogCadenceLaneDue {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$IntervalSeconds,
        [datetime]$Now = (Get-Date)
    )

    if ($Name -eq 'browser_housekeeping') {
        $refreshDue = Get-BrowserHousekeepingRefreshDueState -State $State -Now $Now
        if ($refreshDue.due) { return $true }
    }
    return & $script:BrowserHousekeepingBaseTestLaneDue -State $State -Name $Name -IntervalSeconds $IntervalSeconds -Now $Now
}

function Invoke-BrowserPluginSettingsHousekeeping {
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "ChatGPT browser session CLI is missing: $scriptPath"
    }

    $startedAt = Get-Date
    $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-plugin-settings-cleanup --ports 9222,9223 --max-close 10 --timeout-ms 3000 --confirm-cleanup 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($raw | Out-String).Trim()
    $result = $null
    try { $result = $text | ConvertFrom-Json -Depth 40 } catch {
        $result = [pscustomobject]@{
            ok = $false
            status = 'CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_INVALID_OUTPUT'
            error = Sanitize-Text $_.Exception.Message
            output = Sanitize-Text $text
        }
    }

    $payload = [pscustomobject]@{
        ok = [bool]($exitCode -eq 0 -and $result.ok -eq $true)
        status = if ($exitCode -ne 0) { 'CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_CLI_FAILED' } else { [string]$result.status }
        at = (Get-Date).ToUniversalTime().ToString('o')
        started_at = $startedAt.ToUniversalTime().ToString('o')
        duration_ms = [Math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
        exit_code = $exitCode
        result = $result
    }

    $temporary = "$BrowserHousekeepingStateFile.$PID.tmp"
    $payload | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $BrowserHousekeepingStateFile -Force
    return $payload
}

function Invoke-WatchdogCadenceLane {
    param([Parameter(Mandatory = $true)][ValidateSet('runtime','local_auth','browser','public_tunnel','task_integrity','browser_housekeeping','build_fingerprint')][string]$Name)

    if ($Name -ne 'browser_housekeeping') {
        return & $script:BrowserHousekeepingBaseInvokeLane -Name $Name
    }

    try {
        $housekeeping = Invoke-BrowserPluginSettingsHousekeeping
        return [pscustomobject]@{
            ok = [bool]$housekeeping.ok
            status = if ($housekeeping.ok) { 'BROWSER_HOUSEKEEPING_HEALTHY' } else { 'BROWSER_HOUSEKEEPING_PARTIAL' }
            repair_required = $false
            detail = $housekeeping
        }
    } catch {
        $failure = [pscustomobject]@{
            ok = $false
            status = 'BROWSER_HOUSEKEEPING_FAILED'
            at = (Get-Date).ToUniversalTime().ToString('o')
            error = Sanitize-Text $_.Exception.Message
            script_stack_trace = Sanitize-Text ([string]$_.ScriptStackTrace)
        }
        try {
            $temporary = "$BrowserHousekeepingStateFile.$PID.tmp"
            $failure | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary -Encoding utf8
            Move-Item -LiteralPath $temporary -Destination $BrowserHousekeepingStateFile -Force
        } catch { }
        return [pscustomobject]@{ ok = $false; status = 'BROWSER_HOUSEKEEPING_FAILED'; repair_required = $false; detail = $failure }
    }
}

Set-Variable -Name DevConsoleBrowserHousekeepingModuleLoaded -Scope Script -Value $true -Force
