# Authoritative console-mcp server-process lifecycle for stop-server.
#
# Root cause this module fixes: Stop-ServerForWatchdogRecovery used to call Stop-ChatgptOauth /
# Stop-CodexBearer / Stop-Tunnel best-effort (Invoke-ProcessKill swallowed every Stop-Process error
# via -ErrorAction SilentlyContinue) and then unconditionally reported ok=true / STOP_REQUEST_ACCEPTED
# without ever checking whether the old PID actually exited, whether the port was released, or whether
# a replacement process came up with a different PID. When the kill silently failed (or raced the
# watchdog), the old PID kept owning its port and kept serving the stale in-memory tool schema
# indefinitely, because Get-ManagedProcessState's listener-match fallback then reported it as still
# "managed"/"running", so nothing downstream ever noticed or retried.
#
# The functions below split "find the real candidates", "decide which are confirmed", "kill", and
# "verify" into separately testable pieces, so regression tests can exercise the selection/verification
# logic with synthetic data without touching real processes.

function Get-ConsoleServerEndpointSpecs {
    return @((Get-ChatgptSpec), (Get-CodexSpec))
}

function Get-ConsoleServerPorts {
    return @((Get-ConsoleServerEndpointSpecs) | ForEach-Object { [int]$_.Port } | Sort-Object -Unique)
}

# Pure: no process/registry access. Confirms a candidate is a Node runtime whose command line matches
# the spec's entrypoint pattern (dist/index.js or npm run start). This is intentionally the same
# matcher already used by Get-ManagedProcessState so identity does not regress versus the status quo,
# but it is now the single place that decision is made for lifecycle purposes.
function Test-ConsoleServerProcessIdentity {
    param(
        [string]$ExecutableName,
        [string]$CommandLine,
        [string]$Matcher,
        [string]$WorkspacePath,
        [string[]]$Sources = @()
    )

    if ([string]::IsNullOrWhiteSpace($ExecutableName) -or [string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Matcher)) {
        return $false
    }
    if ($ExecutableName -notmatch '(?i)^node(\.exe)?$' -or $CommandLine -notmatch $Matcher) {
        return $false
    }

    $normalizedWorkspace = if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $null } else { [System.IO.Path]::GetFullPath($WorkspacePath).TrimEnd([char[]]@([char]92, [char]47)).Replace('/', '\\') }
    $normalizedCommandLine = $CommandLine.Replace('/', [char]92)
    $hasAbsoluteWorkspaceEntrypoint = [bool]($normalizedWorkspace -and $normalizedCommandLine.IndexOf(($normalizedWorkspace + '\dist\index.js'), [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    $hasCorroboratedManagedState = ($Sources -contains 'listener') -and (($Sources -contains 'pid_file') -or ($Sources -contains 'watchdog_state'))

    return [bool]($hasAbsoluteWorkspaceEntrypoint -or $hasCorroboratedManagedState)
}

function New-ConsoleServerCandidateRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$SpecName,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Matcher,
        [int]$ProcessId,
        [string]$ExecutableName,
        [string]$CommandLine,
        [string]$ExecutablePath,
        [string]$CreationTime
    )

    return [pscustomobject]@{
        source = $Source
        spec_name = $SpecName
        port = $Port
        matcher = $Matcher
        pid = $ProcessId
        executable_name = $ExecutableName
        command_line = $CommandLine
        executable_path = $ExecutablePath
        creation_time = $CreationTime
    }
}

# Impure: reads the live TCP listener table. This is the highest-priority source - a real listener
# beats a stale PID/state file every time.
function Get-ConsoleServerListenerRecords {
    $records = @()
    foreach ($spec in Get-ConsoleServerEndpointSpecs) {
        $port = [int]$spec.Port
        $listener = Get-ListeningProcessOnPort -Port $port
        if (-not $listener) { continue }

        $ownerPid = [int]$listener.OwningProcess
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $commandLine = if ($process) { [string]$process.CommandLine } else { $null }
        # NOTE: `(if (...) {...} else {...})` as an inline argument value (rather than a plain
        # `$var = if (...) {...} else {...}` assignment beforehand) parses without error but fails
        # at RUNTIME - PowerShell resolves the parenthesized form as "invoke a command named if",
        # which doesn't exist, throwing "The term 'if' is not recognized..." the moment this line
        # actually executes. This went undetected for a long time because stop-server had never
        # been exercised end-to-end before; static syntax checks (AST parsing) don't catch it either,
        # since it is grammatically valid, just semantically wrong. Precompute every branch into a
        # named variable first, then pass the variable - the only reliably safe form.
        $executableName = if ($process) { [string]$process.Name } else { $null }
        $sanitizedCommandLine = if ($commandLine) { Sanitize-Text $commandLine } else { $null }
        $executablePath = if ($process) { [string]$process.ExecutablePath } else { $null }
        $creationTime = if ($process -and $process.CreationDate) { ([datetime]$process.CreationDate).ToString('o') } else { $null }
        $records += New-ConsoleServerCandidateRecord -Source 'listener' -SpecName $spec.Name -Port $port -Matcher $spec.Matcher `
            -ProcessId $ownerPid `
            -ExecutableName $executableName `
            -CommandLine $sanitizedCommandLine `
            -ExecutablePath $executablePath `
            -CreationTime $creationTime
    }
    return @($records)
}

# Impure: reads the per-service PID files this script itself writes. A stale file (recorded PID no
# longer alive, or alive but no longer the port owner) must never be the only source of truth - it is
# merged with, and outranked by, the listener source.
function Get-ConsoleServerPidFileRecords {
    $records = @()
    foreach ($spec in Get-ConsoleServerEndpointSpecs) {
        $recordedPid = Get-ManagedPid -PidFile $spec.PidFile
        if (-not $recordedPid) { continue }
        $alive = Test-ManagedPid -ProcessId $recordedPid
        $process = if ($alive) { Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue } else { $null }
        $commandLine = if ($process) { [string]$process.CommandLine } else { $null }
        $executableName = if ($process) { [string]$process.Name } else { $null }
        $sanitizedCommandLine = if ($commandLine) { Sanitize-Text $commandLine } else { $null }
        $executablePath = if ($process) { [string]$process.ExecutablePath } else { $null }
        $creationTime = if ($process -and $process.CreationDate) { ([datetime]$process.CreationDate).ToString('o') } else { $null }
        $records += New-ConsoleServerCandidateRecord -Source 'pid_file' -SpecName $spec.Name -Port ([int]$spec.Port) -Matcher $spec.Matcher `
            -ProcessId $recordedPid `
            -ExecutableName $executableName `
            -CommandLine $sanitizedCommandLine `
            -ExecutablePath $executablePath `
            -CreationTime $creationTime
    }
    return @($records)
}

# Impure: reads the watchdog heal state file's last known per-service PID. Same outranking rule as
# the PID-file source: this never overrides an identity-confirmed listener, it only adds a candidate.
function Get-ConsoleServerWatchdogStateRecords {
    $watchdogState = Get-WatchdogState
    $detail = $watchdogState.detail
    if (-not $detail) { return @() }

    $keyBySpecName = @{ 'chatgpt-oauth' = 'chatgpt_oauth'; 'codex-bearer' = 'codex_bearer' }
    $records = @()
    foreach ($spec in Get-ConsoleServerEndpointSpecs) {
        $key = $keyBySpecName[$spec.Name]
        if (-not $key -or -not ($detail.PSObject.Properties.Name -contains $key)) { continue }
        $recorded = $detail.$key
        if (-not $recorded -or -not ($recorded.PSObject.Properties.Name -contains 'pid') -or -not $recorded.pid) { continue }

        $recordedPid = [int]$recorded.pid
        $alive = Test-ManagedPid -ProcessId $recordedPid
        $process = if ($alive) { Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue } else { $null }
        $commandLine = if ($process) { [string]$process.CommandLine } else { $null }
        $executableName = if ($process) { [string]$process.Name } else { $null }
        $sanitizedCommandLine = if ($commandLine) { Sanitize-Text $commandLine } else { $null }
        $executablePath = if ($process) { [string]$process.ExecutablePath } else { $null }
        $creationTime = if ($process -and $process.CreationDate) { ([datetime]$process.CreationDate).ToString('o') } else { $null }
        $records += New-ConsoleServerCandidateRecord -Source 'watchdog_state' -SpecName $spec.Name -Port ([int]$spec.Port) -Matcher $spec.Matcher `
            -ProcessId $recordedPid `
            -ExecutableName $executableName `
            -CommandLine $sanitizedCommandLine `
            -ExecutablePath $executablePath `
            -CreationTime $creationTime
    }
    return @($records)
}

# Pure process-selection logic: takes already-fetched candidate records (real or synthetic) from any
# number of sources and reduces them to one entry per PID. A PID is identity_confirmed only if at
# least one contributing record independently passes Test-ConsoleServerProcessIdentity; a listener
# record for a PID always sets listener_owner=$true, and listener ownership is preserved even when a
# stale pid_file/watchdog_state record for a *different* PID exists for the same port - they simply
# become separate, independently-evaluated entries. No process is ever implicitly trusted just because
# it appears in a PID/state file.
function Merge-ConsoleServerCandidateSources {
    param([object[]]$Records = @())

    $byPid = [ordered]@{}
    foreach ($record in @($Records)) {
        if (-not $record.pid) { continue }
        $key = [string]$record.pid

        if (-not $byPid.Contains($key)) {
            $byPid[$key] = [pscustomobject]@{
                pid = [int]$record.pid
                ports = @()
                sources = @()
                spec_names = @()
                executable_path = $null
                command_line = $null
                creation_time = $null
                identity_confirmed = $false
                listener_owner = $false
            }
        }

        $entry = $byPid[$key]
        if ($record.port -and ($entry.ports -notcontains [int]$record.port)) { $entry.ports += [int]$record.port }
        if ($entry.sources -notcontains $record.source) { $entry.sources += $record.source }
        if ($record.spec_name -and ($entry.spec_names -notcontains $record.spec_name)) { $entry.spec_names += $record.spec_name }
        if ($record.source -eq 'listener') { $entry.listener_owner = $true }

        if (-not $entry.executable_path -and $record.executable_path) { $entry.executable_path = $record.executable_path }
        if (-not $entry.command_line -and $record.command_line) { $entry.command_line = $record.command_line }
        if (-not $entry.creation_time -and $record.creation_time) { $entry.creation_time = $record.creation_time }
    }

    foreach ($entry in @($byPid.Values)) {
        $matchingRecord = @($Records | Where-Object { [int]$_.pid -eq [int]$entry.pid -and $_.executable_name -and $_.command_line } | Select-Object -First 1)
        if ($matchingRecord.Count -gt 0) {
            $record = $matchingRecord[0]
            $entry.identity_confirmed = Test-ConsoleServerProcessIdentity -ExecutableName $record.executable_name -CommandLine $record.command_line -Matcher $record.matcher -WorkspacePath $Root -Sources $entry.sources
        }
    }

    return @($byPid.Values)
}

# Impure orchestration: the single reusable place that assembles the authoritative candidate
# inventory. Reused by stop-server (and available for status/health) so discovery logic is not
# duplicated per caller.
function Get-ConsoleServerAuthoritativeInventory {
    $records = @()
    $records += Get-ConsoleServerListenerRecords
    $records += Get-ConsoleServerPidFileRecords
    $records += Get-ConsoleServerWatchdogStateRecords
    return Merge-ConsoleServerCandidateSources -Records $records
}

# Kill primitive with injectable probes so the escalation policy (graceful attempt, bounded wait,
# forced fallback, bounded wait, survived?) can be unit tested without starting/stopping real
# processes. Defaults call the real cmdlets.
function Invoke-ConsoleServerGracefulThenForceStop {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [int]$GraceSeconds = 5,
        [int]$ForceTimeoutSeconds = 8,
        [scriptblock]$TestAlive = { param($id) Test-ManagedPid -ProcessId $id },
        [scriptblock]$InvokeGraceful = { param($id) Stop-Process -Id $id -ErrorAction Stop },
        [scriptblock]$InvokeForce = { param($id) Stop-Process -Id $id -Force -ErrorAction Stop },
        [scriptblock]$Sleeper = { param($ms) Start-Sleep -Milliseconds $ms }
    )

    $result = [ordered]@{
        pid = $ProcessId
        graceful_attempted = $false
        graceful_error = $null
        force_attempted = $false
        force_error = $null
        survived = $false
    }

    if (-not (& $TestAlive $ProcessId)) {
        return [pscustomobject]$result
    }

    $result.graceful_attempted = $true
    try {
        & $InvokeGraceful $ProcessId
    } catch {
        $result.graceful_error = Sanitize-Text $_.Exception.Message
    }

    $graceDeadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $graceDeadline -and (& $TestAlive $ProcessId)) {
        & $Sleeper 250
    }

    if (& $TestAlive $ProcessId) {
        $result.force_attempted = $true
        try {
            & $InvokeForce $ProcessId
        } catch {
            $result.force_error = Sanitize-Text $_.Exception.Message
        }

        $forceDeadline = (Get-Date).AddSeconds($ForceTimeoutSeconds)
        while ((Get-Date) -lt $forceDeadline -and (& $TestAlive $ProcessId)) {
            & $Sleeper 250
        }
    }

    $result.survived = [bool](& $TestAlive $ProcessId)
    return [pscustomobject]$result
}

# Only ever stops candidates the caller has already marked identity_confirmed=$true. Anything else is
# recorded as skipped, never touched - this is the enforcement point for "never kill an unconfirmed
# process" regardless of what upstream callers pass in.
function Stop-ConsoleServerConfirmedProcesses {
    param([object[]]$Candidates = @())

    $results = @()
    foreach ($candidate in @($Candidates)) {
        if (-not $candidate.identity_confirmed) {
            $results += [pscustomobject]@{
                pid = $candidate.pid
                skipped = $true
                reason = 'identity_not_confirmed'
                survived = $true
                graceful_attempted = $false
                force_attempted = $false
            }
            continue
        }

        $stop = Invoke-ConsoleServerGracefulThenForceStop -ProcessId ([int]$candidate.pid)
        $results += [pscustomobject]@{
            pid = $stop.pid
            skipped = $false
            reason = $null
            survived = $stop.survived
            graceful_attempted = $stop.graceful_attempted
            graceful_error = $stop.graceful_error
            force_attempted = $stop.force_attempted
            force_error = $stop.force_error
            ports = $candidate.ports
            spec_names = $candidate.spec_names
        }
    }
    return @($results)
}

# Injectable listener probe so port-release waiting can be tested with a canned sequence of
# owner-PIDs instead of a real socket.
function Wait-ConsoleServerPortsReleasedFromPids {
    param(
        [Parameter(Mandatory = $true)][int[]]$Ports,
        [int[]]$OldPids = @(),
        [int]$TimeoutSeconds = 15,
        [scriptblock]$ListenerProbe = { param($port) Get-ListeningProcessOnPort -Port $port },
        [scriptblock]$Sleeper = { param($ms) Start-Sleep -Milliseconds $ms }
    )

    if (@($OldPids).Count -eq 0) {
        return [pscustomobject]@{ ok = $true; remaining = @() }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $stillOwned = @()
        foreach ($port in $Ports) {
            $listener = & $ListenerProbe $port
            if ($listener -and ($OldPids -contains [int]$listener.OwningProcess)) {
                $stillOwned += [pscustomobject]@{ port = $port; pid = [int]$listener.OwningProcess }
            }
        }
        if ($stillOwned.Count -eq 0) {
            return [pscustomobject]@{ ok = $true; remaining = @() }
        }
        & $Sleeper 300
    } while ((Get-Date) -lt $deadline)

    return [pscustomobject]@{ ok = $false; remaining = $stillOwned }
}

# Pure: given a before/after {port; pid} listener snapshot, decides whether every port that had an
# owner before now has a *different* owner. Used both for the final pid_replaced verdict and for
# regression tests (synthetic before/after arrays, no live listeners required).
function Test-ConsoleServerPidReplaced {
    param(
        [Parameter(Mandatory = $true)][int[]]$Ports,
        [object[]]$BeforeListeners = @(),
        [object[]]$AfterListeners = @()
    )

    foreach ($port in $Ports) {
        $beforePid = (@($BeforeListeners) | Where-Object { [int]$_.port -eq [int]$port } | Select-Object -First 1).pid
        $afterPid = (@($AfterListeners) | Where-Object { [int]$_.port -eq [int]$port } | Select-Object -First 1).pid
        if ($beforePid -and $afterPid -and ([int]$beforePid -eq [int]$afterPid)) {
            return $false
        }
    }
    return $true
}

# Waits (bounded) for both endpoints to report a running, port-open, non-old-PID process that also
# passes its local smoke check. This is the "replacement is healthy" postcondition - deliberately
# scoped to just chatgpt/codex health, not the full watchdog heal (tunnel/browser/mobile-edge), so
# stop-server's verdict does not depend on unrelated subsystems.
function Wait-ConsoleServerReplacementReady {
    param(
        [int[]]$OldPids = @(),
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
        $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
        $chatgptFresh = [bool]($chatgptState.running -and $chatgptState.port_open -and $chatgptState.pid -and ($OldPids -notcontains [int]$chatgptState.pid))
        $codexFresh = [bool]($codexState.running -and $codexState.port_open -and $codexState.pid -and ($OldPids -notcontains [int]$codexState.pid))

        if ($chatgptFresh -and $codexFresh) {
            $chatgptSmoke = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
            $codexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
            $last = [pscustomobject]@{
                ok = [bool]($chatgptSmoke.ok -eq $true -and $codexSmoke.ok -eq $true)
                chatgpt = $chatgptState
                codex = $codexState
                chatgpt_smoke = $chatgptSmoke
                codex_smoke = $codexSmoke
            }
            if ($last.ok) { return $last }
        } else {
            $last = [pscustomobject]@{ ok = $false; chatgpt = $chatgptState; codex = $codexState; reason = 'waiting_for_replacement_pid' }
        }

        Start-Sleep -Milliseconds 500
    }

    return $last
}

function Wait-ConsoleConnectorSchemaPropagation {
    param(
        [Parameter(Mandatory = $true)][datetime]$NotBefore,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Get-ChatgptConnectorRefreshState
        $stateAt = $null
        try { $stateAt = [datetime]::Parse([string]$last.at) } catch { $stateAt = $null }
        if ($stateAt -and $stateAt.ToUniversalTime() -ge $NotBefore.ToUniversalTime().AddSeconds(-1)) {
            if ($last.ok -eq $true -or $last.status -match '^(CONNECTOR_SCHEMA_PROPAGATION_CONFIRMED|CONNECTOR_REFRESH_CLICKED_SCHEMA_FETCH_PENDING|CONNECTOR_REFRESH_NOT_CLICKED|CHATGPT_SCHEMA_FINGERPRINT_MISMATCH|CONNECTOR_SCHEMA_PROPAGATION_UNCONFIRMED)$') {
                return $last
            }
        }
        Start-Sleep -Milliseconds 500
    }

    if ($last) { return $last }
    return [pscustomobject]@{ ok = $false; status = 'CONNECTOR_SCHEMA_PROPAGATION_TIMEOUT'; at = (Get-Date).ToString('o'); state_file = $ConnectorRefreshStateFile }
}

# Counts live processes whose command line looks like a watchdog-loop-run instance, so resuming the
# watchdog never leaves two loops racing.
function Get-ConsoleWatchdogLoopInstanceCount {
    $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe' or Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match '(?i)watchdog-loop-run' })
    return $matches.Count
}

# The confirmed, verified stop-server orchestrator. Replaces the old fire-and-forget behavior of
# Stop-ServerForWatchdogRecovery: every step here either confirms an outcome or the overall result is
# marked ok=$false, so a survived old PID can never be silently reported as a success.
function Invoke-ConsoleServerConfirmedStop {
    $operationStartedAt = Get-Date
    $ports = Get-ConsoleServerPorts
    $beforeListeners = Get-ConsoleServerListenerRecords
    $beforeInventory = Get-ConsoleServerAuthoritativeInventory
    Write-ServerLifecycleEvent -Operation 'stop-server' -Phase 'BEFORE_SNAPSHOT' -Status 'BEFORE_SNAPSHOT' -Ok $true -Detail @{ ports = $ports; before = $beforeInventory } | Out-Null

    $watchdogBefore = Get-WatchdogLoopProcessState
    $watchdogPaused = $false
    if ($watchdogBefore.running) {
        Stop-WatchdogLoop | Out-Null
        $watchdogPaused = $true
    }

    $watchdogAfter = $null
    try {
        $confirmed = @($beforeInventory | Where-Object { $_.identity_confirmed })
        $stopResults = Stop-ConsoleServerConfirmedProcesses -Candidates $confirmed
        $stoppedPids = @($confirmed | ForEach-Object { [int]$_.pid })
        $survivingOldPids = @($stopResults | Where-Object { -not $_.skipped -and $_.survived } | ForEach-Object { [int]$_.pid })

        $release = Wait-ConsoleServerPortsReleasedFromPids -Ports $ports -OldPids $stoppedPids -TimeoutSeconds 15
        $portsReleased = [bool]$release.ok

        # Resume watchdog exactly once, regardless of outcome above, so it never stays disabled.
        $watchdogAfter = Start-WatchdogLoop | ConvertFrom-Json
        $watchdogResumed = [bool]$watchdogAfter.running
        $watchdogInstanceCount = Get-ConsoleWatchdogLoopInstanceCount

        $replacement = $null
        if ($survivingOldPids.Count -eq 0 -and $portsReleased) {
            $replacement = Wait-ConsoleServerReplacementReady -OldPids $stoppedPids -TimeoutSeconds 90
        }

        $afterListeners = Get-ConsoleServerListenerRecords
        $pidReplaced = Test-ConsoleServerPidReplaced -Ports $ports -BeforeListeners $beforeListeners -AfterListeners $afterListeners
        $schemaPropagation = if ($replacement -and $replacement.ok -eq $true) { Wait-ConsoleConnectorSchemaPropagation -NotBefore $operationStartedAt -TimeoutSeconds 90 } else { $null }
        $schemaPropagationOk = [bool]($schemaPropagation -and $schemaPropagation.ok -eq $true)
        $schemaPropagationPending = [bool]($schemaPropagation -and $schemaPropagation.status -eq 'CONNECTOR_REFRESH_CLICKED_SCHEMA_FETCH_PENDING')
        $serverRestartOk = [bool](
            $survivingOldPids.Count -eq 0 -and
            $portsReleased -and
            $watchdogResumed -and
            $watchdogInstanceCount -le 1 -and
            $replacement -and $replacement.ok -eq $true -and
            $pidReplaced
        )
        $ok = [bool]($serverRestartOk -and ($schemaPropagationOk -or $schemaPropagationPending))
        $status = if ($serverRestartOk -and $schemaPropagationOk) { 'CONSOLE_SERVER_RESTARTED_SCHEMA_CONFIRMED' } elseif ($serverRestartOk -and $schemaPropagationPending) { 'CONSOLE_SERVER_RESTARTED_SCHEMA_PENDING' } elseif ($serverRestartOk) { 'CONSOLE_SERVER_RESTARTED_SCHEMA_UNCONFIRMED' } else { 'CONSOLE_SERVER_STOP_INCOMPLETE' }

        $result = [pscustomobject]@{
            ok = $ok
            status = $status
            workspace = $Root
            ports = $ports
            before = [pscustomobject]@{ listeners = $beforeListeners; candidates = $beforeInventory }
            stop_results = $stopResults
            stopped_pids = $stoppedPids
            surviving_old_pids = $survivingOldPids
            ports_released = $portsReleased
            occupied_ports = @($release.remaining | ForEach-Object { $_.port })
            watchdog = [pscustomobject]@{
                paused = $watchdogPaused
                resumed = $watchdogResumed
                single_instance = [bool]($watchdogInstanceCount -le 1)
                instance_count = $watchdogInstanceCount
                previous_pid = $watchdogBefore.pid
                pid = $watchdogAfter.pid
            }
            after = [pscustomobject]@{ listeners = $afterListeners; health_ok = [bool]($replacement -and $replacement.ok -eq $true); health = $replacement }
            pid_replaced = $pidReplaced
            connector_schema_propagation = $schemaPropagation
            schema_propagation_confirmed = $schemaPropagationOk
        }

        Write-ServerLifecycleEvent -Operation 'stop-server' -Phase $status -Status $status -Ok $ok -Detail $result | Out-Null
        return $result
    } catch {
        # Never leave the watchdog disabled just because a verification step above threw.
        if (-not (Get-WatchdogLoopProcessState).running) {
            Start-WatchdogLoop | Out-Null
        }
        $message = Sanitize-Text $_.Exception.Message
        Write-ServerLifecycleEvent -Operation 'stop-server' -Phase 'FAILED' -Status 'CONSOLE_SERVER_STOP_INCOMPLETE' -Ok $false -ErrorMessage $message | Out-Null
        return [pscustomobject]@{
            ok = $false
            status = 'CONSOLE_SERVER_STOP_INCOMPLETE'
            workspace = $Root
            ports = $ports
            error = $message
        }
    }
}
