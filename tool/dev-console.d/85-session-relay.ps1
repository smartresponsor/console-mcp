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

$ServerControlRequestFile = Join-Path $RunDir 'console-mcp-server-control-request.json'
$ServerControlResponseDir = Join-Path $RunDir 'server-control-responses'

function New-ServerControlCorrelationId {
    return [guid]::NewGuid().ToString('N')
}

# Entry point for every caller (SSH, interactive, agent) that wants the server stopped or started.
# Never touches the node process itself - only ever talks to the watchdog-loop process via a
# request/response file pair, so the actual Start-ManagedProcess/Stop-ManagedProcess call always
# happens inside that (Task-Scheduler-bound, session-correct) process, never inside this one.
function Request-ServerControlAction {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('stop-server', 'start-server')][string]$Action,
        # Invoke-ConsoleServerConfirmedStop's own internal waits can sum to up to ~195s in the
        # worst case (15s port-release + 90s replacement-ready + 90s connector schema-propagation
        # confirmation, the last of which added by a later change to 90-server-lifecycle.ps1 and
        # will legitimately run its full 90s whenever nothing has triggered a ChatGPT connector
        # refresh). 150s was tuned before that third stage existed and was too tight - it caused
        # SERVER_CONTROL_REQUEST_TIMED_OUT even though the request had already been claimed and was
        # genuinely still in progress, not stuck. Give real headroom above the true worst case.
        [int]$TimeoutSeconds = 220
    )

    Ensure-Directories
    New-Item -ItemType Directory -Force -Path $ServerControlResponseDir | Out-Null

    # Build is session-independent (no desktop/UI dependency) - do it here, in the caller's own
    # session, synchronously, BEFORE handing off. Previously a stale dist could only be discovered
    # and rebuilt by the watchdog loop's own tick, competing for time inside stop-server's fixed
    # wait window. Now the replacement the watchdog starts is guaranteed already-fresh dist.
    $buildOutput = Ensure-BuildOutput

    $callerSessionId = $null
    try { $callerSessionId = (Get-Process -Id $PID).SessionId } catch { $callerSessionId = $null }

    $correlationId = New-ServerControlCorrelationId
    $responseFile = Join-Path $ServerControlResponseDir "$correlationId.json"
    $request = [pscustomobject]@{
        correlation_id = $correlationId
        action = $Action
        requested_at = (Get-Date).ToString('o')
        requested_by_pid = $PID
        requested_by_session = $callerSessionId
        response_file = $responseFile
    }
    $request | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ServerControlRequestFile -Encoding utf8

    # Idempotent: if the watchdog loop is already running (correctly, via the scheduled task), this
    # is a no-op. If it is down, this brings it up via Start-ScheduledTask - never via a raw
    # Start-Process bound to whatever session is asking.
    Start-WatchdogLoop | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $responseFile -PathType Leaf) {
            try {
                $response = Get-Content -LiteralPath $responseFile -Raw | ConvertFrom-Json -Depth 30
                Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue
                $response | Add-Member -NotePropertyName build_output -NotePropertyValue $buildOutput -Force
                $response | Add-Member -NotePropertyName caller_session -NotePropertyValue $callerSessionId -Force
                return $response
            } catch {
                Start-Sleep -Milliseconds 300
                continue
            }
        }
        Start-Sleep -Milliseconds 500
    }

    return [pscustomobject]@{
        ok = $false
        status = 'SERVER_CONTROL_REQUEST_TIMED_OUT'
        correlation_id = $correlationId
        action = $Action
        timeout_seconds = $TimeoutSeconds
        caller_session = $callerSessionId
        request_file = $ServerControlRequestFile
        note = 'The watchdog-loop process did not pick up and complete this request in time. Check: show-watchdog-task (is the scheduled task registered and enabled?), check-autologon, check-console-session (is the interactive session available for the task to run in?).'
    }
}

# Called once per tick from inside the (session-bound) watchdog loop, BEFORE Invoke-WatchdogHeal.
# Picks up at most one pending request, executes it with the real implementations, and reports the
# session it actually ran in - so any future session drift is visible in the response itself rather
# than silently reintroduced.
function Invoke-PendingServerControlRequest {
    if (-not (Test-Path -LiteralPath $ServerControlRequestFile -PathType Leaf)) {
        return $null
    }

    $request = $null
    try {
        $request = Get-Content -LiteralPath $ServerControlRequestFile -Raw | ConvertFrom-Json -Depth 20
    } catch {
        Remove-Item -LiteralPath $ServerControlRequestFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    # Claim immediately so a fast-repeating tick never double-processes the same request.
    Remove-Item -LiteralPath $ServerControlRequestFile -Force -ErrorAction SilentlyContinue

    $executingSessionId = $null
    try { $executingSessionId = (Get-Process -Id $PID).SessionId } catch { $executingSessionId = $null }

    $result = $null
    try {
        $result = switch ([string]$request.action) {
            'stop-server' { Invoke-ConsoleServerConfirmedStop }
            'start-server' {
                Start-UnifiedConsoleRuntime | Out-Null
                $ready = Wait-ConsoleServerReplacementReady -OldPids @() -TimeoutSeconds 90
                $startOk = [bool]($ready -and $ready.ok -eq $true)
                $startStatus = if ($startOk) { 'CONSOLE_SERVER_STARTED' } else { 'CONSOLE_SERVER_START_INCOMPLETE' }
                [pscustomobject]@{ ok = $startOk; status = $startStatus; detail = $ready }
            }
            default { [pscustomobject]@{ ok = $false; status = 'UNKNOWN_SERVER_CONTROL_ACTION'; action = $request.action } }
        }
    } catch {
        # Message alone ('The term X is not recognized...') is not enough to locate a runtime
        # command-resolution failure like this - it never says WHICH file/line/function called the
        # bad command. Capture the full script stack trace so the next occurrence is a one-shot fix
        # instead of another round of blind searching across several files.
        $result = [pscustomobject]@{
            ok = $false
            status = 'SERVER_CONTROL_ACTION_FAILED'
            error = Sanitize-Text $_.Exception.Message
            script_stack_trace = Sanitize-Text ([string]$_.ScriptStackTrace)
            invocation_line = Sanitize-Text ([string]$_.InvocationInfo.Line)
            invocation_position = Sanitize-Text ([string]$_.InvocationInfo.PositionMessage)
        }
    }

    $response = [pscustomobject]@{
        correlation_id = $request.correlation_id
        action = $request.action
        requested_at = $request.requested_at
        requested_by_session = $request.requested_by_session
        executed_at = (Get-Date).ToString('o')
        executed_by_session = $executingSessionId
        session_matches_interactive = [bool]((Get-ConsoleSessionReport).active_console -and (Get-ConsoleSessionReport).active_console.id -eq $executingSessionId)
        result = $result
    }

    $responseFile = [string]$request.response_file
    if (-not [string]::IsNullOrWhiteSpace($responseFile)) {
        Ensure-Directories
        $response | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $responseFile -Encoding utf8
    }
    return $response
}
