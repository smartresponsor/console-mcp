# Session-safe server control relay.
#
# Root cause this module fixes: SSH is meant to be the primary control point for console-mcp, but
# `Start-Process` in Windows binds a child process to the SESSION OF THE PARENT PowerShell process.
# An SSH session and the interactive desktop session (session 1, where visible Edge/CDP automation
# for the ChatGPT browser stack must run) are different Windows sessions. Any code path that called
# Start-Process directly from a command issued over SSH silently re-homed the watchdog loop (and,
# through it, the unified node server) into the SSH session - which is exactly the kind of drift
# this file exists to make structurally impossible, not just "usually avoided by remembering to use
# the right terminal".
#
# The fix: the ONLY process ever allowed to Start-ManagedProcess/Stop-ManagedProcess the unified
# console-mcp runtime is the watchdog loop, and the watchdog loop is ONLY ever launched via the
# `console-mcp-watchdog` Scheduled Task (Principal LogonType=Interactive), never via a bare
# Start-Process from whichever session issued the command. Every other entry point - SSH, an
# interactive PowerShell, an agent, a future tool - goes through Request-ServerControlAction below,
# which hands a request to that session-bound process and waits for its answer. There is no direct
# path left that lets the caller's own session leak into the server process's session.

$ServerControlRoot = Join-Path $RunDir 'server-control'
$ServerControlInboxDir = Join-Path $ServerControlRoot 'inbox'
$ServerControlClaimedDir = Join-Path $ServerControlRoot 'claimed'
$ServerControlResponseDir = Join-Path $ServerControlRoot 'results'
$ServerControlBrokerStateFile = Join-Path $ServerControlRoot 'broker.json'

function New-ServerControlCorrelationId {
    return [guid]::NewGuid().ToString('N')
}

function Initialize-ServerControlQueue {
    foreach ($path in @($ServerControlRoot, $ServerControlInboxDir, $ServerControlClaimedDir, $ServerControlResponseDir)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Write-ServerControlJsonAtomically {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-ServerControlBrokerIdentity {
    if (-not (Test-Path -LiteralPath $ServerControlBrokerStateFile -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $ServerControlBrokerStateFile -Raw | ConvertFrom-Json -Depth 20 } catch { return $null }
}

function Write-ServerControlBrokerIdentity {
    param([Parameter(Mandatory = $true)]$Identity)
    Initialize-ServerControlQueue
    Write-ServerControlJsonAtomically -Path $ServerControlBrokerStateFile -Value $Identity
}

function New-ServerControlBrokerIdentity {
    $sessionId = $null
    try { $sessionId = (Get-Process -Id $PID).SessionId } catch { $sessionId = $null }
    $userSid = $null
    try { $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $userSid = $null }
    $bootEpoch = $null
    try { $bootEpoch = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o') } catch { $bootEpoch = $null }
    $console = Get-ConsoleSessionReport
    $loginEpoch = if ($console.active_console) { "session:$($console.active_console.id):$((Get-Date).ToUniversalTime().ToString('yyyyMMdd'))" } else { $null }
    return [pscustomobject]@{
        generation = [guid]::NewGuid().ToString('N')
        pid = $PID
        windows_session_id = $sessionId
        user_sid = $userSid
        started_at = (Get-Date).ToUniversalTime().ToString('o')
        boot_epoch = $bootEpoch
        login_epoch = $loginEpoch
        heartbeat_sequence = 0
        heartbeat_at = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Update-ServerControlBrokerHeartbeat {
    param([Parameter(Mandatory = $true)]$Identity)
    $Identity.heartbeat_sequence = [int64]$Identity.heartbeat_sequence + 1
    $Identity.heartbeat_at = (Get-Date).ToUniversalTime().ToString('o')
    Write-ServerControlBrokerIdentity -Identity $Identity
    return $Identity
}

# Entry point for every caller (SSH, interactive, agent) that wants the server stopped or started.
# Never touches the node process itself - only ever talks to the watchdog-loop process via a
# request/response file pair, so the actual Start-ManagedProcess/Stop-ManagedProcess call always
# happens inside that (Task-Scheduler-bound, session-correct) process, never inside this one.
function Request-ServerControlAction {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('stop-server', 'start-server')][string]$Action,
        [int]$TimeoutSeconds = 150
    )

    Ensure-Directories
    Initialize-ServerControlQueue
    $buildOutput = Ensure-BuildOutput
    $loopStartRaw = Start-WatchdogLoop
    $loopStart = try { $loopStartRaw | ConvertFrom-Json } catch { $loopStartRaw }
    $loopState = Get-WatchdogLoopProcessState
    if (-not $loopState.running) {
        return [pscustomobject]@{
            ok = $false
            status = 'INTERACTIVE_EXECUTOR_UNAVAILABLE'
            action = $Action
            loop_start = $loopStart
            loop = $loopState
            build_output = $buildOutput
        }
    }

    $callerSessionId = $null
    try { $callerSessionId = (Get-Process -Id $PID).SessionId } catch { $callerSessionId = $null }
    $broker = Get-ServerControlBrokerIdentity
    $correlationId = New-ServerControlCorrelationId
    $requestFile = Join-Path $ServerControlInboxDir "$correlationId.json"
    $responseFile = Join-Path $ServerControlResponseDir "$correlationId.json"
    $request = [pscustomobject]@{
        schema_version = 2
        correlation_id = $correlationId
        idempotency_key = "${Action}:$correlationId"
        action = $Action
        requested_at = (Get-Date).ToUniversalTime().ToString('o')
        deadline_at = (Get-Date).ToUniversalTime().AddSeconds($TimeoutSeconds).ToString('o')
        requested_by_pid = $PID
        requested_by_session = $callerSessionId
        expected_broker_generation = if ($broker) { [string]$broker.generation } else { $null }
        expected_login_epoch = if ($broker) { [string]$broker.login_epoch } else { $null }
    }
    Write-ServerControlJsonAtomically -Path $requestFile -Value $request

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $responseFile -PathType Leaf) {
            try {
                $response = Get-Content -LiteralPath $responseFile -Raw | ConvertFrom-Json -Depth 30
                if ($response.completed -eq $true) {
                    $response | Add-Member -NotePropertyName build_output -NotePropertyValue $buildOutput -Force
                    $response | Add-Member -NotePropertyName caller_session -NotePropertyValue $callerSessionId -Force
                    return $response
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 300
    }

    return [pscustomobject]@{
        ok = $false
        status = 'SERVER_CONTROL_RESULT_PENDING'
        correlation_id = $correlationId
        action = $Action
        timeout_seconds = $TimeoutSeconds
        caller_session = $callerSessionId
        request_file = $requestFile
        receipt_file = $responseFile
        next_action = 'poll the durable receipt; do not submit another stop-server request'
        build_output = $buildOutput
    }
}

# Called once per tick from inside the (session-bound) watchdog loop, BEFORE Invoke-WatchdogHeal.
# Picks up at most one pending request, executes it with the real implementations, and reports the
# session it actually ran in - so any future session drift is visible in the response itself rather
# than silently reintroduced.
function Invoke-PendingServerControlRequest {
    Initialize-ServerControlQueue
    $broker = Get-ServerControlBrokerIdentity
    if (-not $broker) { return $null }

    $claim = $null
    foreach ($item in @(Get-ChildItem -LiteralPath $ServerControlInboxDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object CreationTimeUtc, Name)) {
        $claimedPath = Join-Path $ServerControlClaimedDir $item.Name
        try {
            Move-Item -LiteralPath $item.FullName -Destination $claimedPath -ErrorAction Stop
            $request = Get-Content -LiteralPath $claimedPath -Raw | ConvertFrom-Json -Depth 20
            $claim = [pscustomobject]@{ path = $claimedPath; request = $request; claimed_at = (Get-Date).ToUniversalTime().ToString('o') }
            break
        } catch { continue }
    }
    if (-not $claim) { return $null }

    $executingSessionId = $null
    try { $executingSessionId = (Get-Process -Id $PID).SessionId } catch { $executingSessionId = $null }
    $request = $claim.request
    $generationMatches = [bool]([string]::IsNullOrWhiteSpace([string]$request.expected_broker_generation) -or [string]$request.expected_broker_generation -eq [string]$broker.generation)
    $loginEpochMatches = [bool]([string]::IsNullOrWhiteSpace([string]$request.expected_login_epoch) -or [string]$request.expected_login_epoch -eq [string]$broker.login_epoch)

    if (-not $generationMatches -or -not $loginEpochMatches) {
        $result = [pscustomobject]@{
            ok = $false
            status = 'STALE_BROKER_GENERATION'
            expected_generation = $request.expected_broker_generation
            actual_generation = $broker.generation
            expected_login_epoch = $request.expected_login_epoch
            actual_login_epoch = $broker.login_epoch
        }
    } else {
        try {
            $result = switch ([string]$request.action) {
                'stop-server' { Invoke-ConsoleServerConfirmedStop }
                'start-server' {
                    Start-UnifiedConsoleRuntime | Out-Null
                    $ready = Wait-ConsoleServerReplacementReady -OldPids @() -TimeoutSeconds 90
                    $startOk = [bool]($ready -and $ready.ok -eq $true)
                    [pscustomobject]@{ ok = $startOk; status = if ($startOk) { 'CONSOLE_SERVER_STARTED' } else { 'CONSOLE_SERVER_START_INCOMPLETE' }; detail = $ready }
                }
                default { [pscustomobject]@{ ok = $false; status = 'UNKNOWN_SERVER_CONTROL_ACTION'; action = $request.action } }
            }
        } catch {
            $result = [pscustomobject]@{
                ok = $false
                status = 'SERVER_CONTROL_ACTION_FAILED'
                error = Sanitize-Text $_.Exception.Message
                script_stack_trace = Sanitize-Text ([string]$_.ScriptStackTrace)
                invocation_line = Sanitize-Text ([string]$_.InvocationInfo.Line)
                invocation_position = Sanitize-Text ([string]$_.InvocationInfo.PositionMessage)
            }
        }
    }

    $response = [pscustomobject]@{
        schema_version = 2
        correlation_id = $request.correlation_id
        action = $request.action
        requested_at = $request.requested_at
        claimed_at = $claim.claimed_at
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
        requested_by_session = $request.requested_by_session
        executed_by_session = $executingSessionId
        broker_generation = $broker.generation
        broker_pid = $broker.pid
        claimed = $true
        completed = $true
        session_matches_interactive = [bool]((Get-ConsoleSessionReport).active_console -and (Get-ConsoleSessionReport).active_console.id -eq $executingSessionId)
        result = $result
    }
    $responseFile = Join-Path $ServerControlResponseDir "$($request.correlation_id).json"
    Write-ServerControlJsonAtomically -Path $responseFile -Value $response
    Remove-Item -LiteralPath $claim.path -Force -ErrorAction SilentlyContinue
    return $response
}
