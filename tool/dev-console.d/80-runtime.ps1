function Start-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $bearerToken = $null
    if ($Spec.RequiresBearerToken) {
        if ($Spec.PSObject.Properties.Name -contains 'Environment' -and $Spec.Environment -and $Spec.Environment.Contains('CONSOLE_MCP_BEARER_TOKEN')) {
            $bearerToken = [string]$Spec.Environment.CONSOLE_MCP_BEARER_TOKEN
        } else {
            $bearerToken = Get-ConsoleBearerToken
        }
    }

    $state = Get-ManagedProcessState -Spec $Spec
    if ($state.running) {
        return $state | ConvertTo-Json -Depth 10
    }

    if ($state.port_conflict) {
        throw "$($Spec.Name) cannot start because port $($Spec.Port) is already in use."
    }


      Remove-Item -LiteralPath $Spec.PidFile -Force -ErrorAction SilentlyContinue
      Set-Content -LiteralPath $Spec.LogFile -Value '' -Encoding utf8

      $childEnvironment = @{}
      if ($Spec.PSObject.Properties.Name -contains 'Environment' -and $null -ne $Spec.Environment) {
          foreach ($entry in $Spec.Environment.GetEnumerator()) {
              $childEnvironment[[string]$entry.Key] = [string]$entry.Value
          }
      }

      if ($Spec.RequiresBearerToken) {
          $childEnvironment['CONSOLE_MCP_BEARER_TOKEN'] = [string]$bearerToken
      } else {
          $childEnvironment['CONSOLE_MCP_BEARER_TOKEN'] = $null
      }

      $process = Start-Process `
          -FilePath $FilePath `
          -ArgumentList $Arguments `
          -WorkingDirectory $Root `
          -Environment $childEnvironment `
          -PassThru `
          -WindowStyle Hidden `
          -RedirectStandardOutput $Spec.LogFile `
          -RedirectStandardError ($Spec.LogFile + '.err')

      Set-Content -LiteralPath $Spec.PidFile -Value $process.Id -NoNewline

    if ($Spec.Port -gt 0) {
        Wait-ForPortOpen -Port $Spec.Port -TimeoutSeconds 30
    } elseif (-not (Test-ManagedPid -ProcessId $process.Id)) {
        throw "$($Spec.Name) exited before it became ready."
    }

    return (Get-ManagedProcessState -Spec $Spec | ConvertTo-Json -Depth 10)
}

function Stop-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)]$Spec
    )

    $state = Get-ManagedProcessState -Spec $Spec
    $managedPid = $state.pid
    $killResult = $null
    if ($state.running -and $managedPid -and -not $state.port_conflict) {
        # Was: Invoke-ProcessKill (Stop-Process -Force -ErrorAction SilentlyContinue), fire-and-
        # forget with no confirmation the process actually exited. That let Start-ManagedProcess's
        # own "already running" guard see the SAME still-alive PID immediately afterward and skip
        # spawning a replacement entirely - a stale runtime then persisted indefinitely with no
        # further attempt to fix it, invisible to the caller because this function reported success
        # regardless. Reuse the same graceful-then-forced-with-verification primitive stop-server
        # already uses (tool/dev-console.d/90-server-lifecycle.ps1), so every internal auto-heal
        # path (Invoke-WatchdogHeal, Invoke-ManagedRestart) gets the same guarantee stop-server has.
        $killResult = Invoke-ConsoleServerGracefulThenForceStop -ProcessId ([int]$managedPid)
    } elseif ($state.port_conflict) {
        Write-Output "$($Spec.Name) is not managed by this supervisor, so it was not terminated."
    } else {
        $matched = Get-ManagedProcessByMatcher -Matcher $Spec.Matcher
        if ($matched) {
            $killResult = Invoke-ConsoleServerGracefulThenForceStop -ProcessId ([int]$matched.ProcessId)
        }
    }

    Remove-Item -LiteralPath $Spec.PidFile -Force -ErrorAction SilentlyContinue
    $result = Get-ManagedProcessState -Spec $Spec
    if ($killResult) {
        $result | Add-Member -NotePropertyName kill_survived -NotePropertyValue ([bool]$killResult.survived) -Force
        $result | Add-Member -NotePropertyName kill_detail -NotePropertyValue $killResult -Force
    }
    return ($result | ConvertTo-Json -Depth 10)
}

function Get-ManagedRuntimeState {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [object]$Process = $null,
        [bool]$Running = $false,
        [bool]$PortConflict = $false
    )

    if ($PortConflict -or -not $Running -or -not $Process) {
        return [pscustomobject]@{ state = 'unknown'; reason = if ($PortConflict) { 'foreign_listener' } elseif (-not $Running) { 'not_running' } else { 'process_unavailable' }; process_started_at = $null; dist_last_write_time = $null }
    }
    if ($Spec.Name -notin @('chatgpt-oauth', 'codex-bearer')) {
        return [pscustomobject]@{ state = 'unknown'; reason = 'runtime_fingerprint_not_applicable'; process_started_at = $null; dist_last_write_time = $null }
    }

    $build = Get-BuildOutputReport
    $processStartedAt = $null
    if ($Process.CreationDate) {
        try { $processStartedAt = [datetime]$Process.CreationDate } catch { $processStartedAt = $null }
    }
    $distLastWrite = $null
    if ($build.dist_index -and $build.dist_index.exists -and $build.dist_index.last_write_time) {
        try { $distLastWrite = [datetime]$build.dist_index.last_write_time } catch { $distLastWrite = $null }
    }

    if ($build.build_needed -eq $true -or $build.build_current -eq $false) {
        return [pscustomobject]@{ state = 'stale'; reason = $build.build_reason; process_started_at = if ($processStartedAt) { $processStartedAt.ToString('o') } else { $null }; dist_last_write_time = if ($distLastWrite) { $distLastWrite.ToString('o') } else { $null } }
    }
    if ($processStartedAt -and $distLastWrite) {
        $current = $processStartedAt.ToUniversalTime() -ge $distLastWrite.ToUniversalTime().AddSeconds(-2)
        return [pscustomobject]@{ state = if ($current) { 'current' } else { 'stale' }; reason = if ($current) { 'process_started_after_dist_build' } else { 'process_started_before_dist_build' }; process_started_at = $processStartedAt.ToString('o'); dist_last_write_time = $distLastWrite.ToString('o') }
    }
    return [pscustomobject]@{ state = 'unknown'; reason = 'runtime_timestamps_unavailable'; process_started_at = if ($processStartedAt) { $processStartedAt.ToString('o') } else { $null }; dist_last_write_time = if ($distLastWrite) { $distLastWrite.ToString('o') } else { $null } }
}

function Get-ManagedProcessState {
    param([Parameter(Mandatory = $true)]$Spec)

    $managedPid = Get-ManagedPid -PidFile $Spec.PidFile
    $pidAlive = $managedPid -and (Test-ManagedPid -ProcessId $managedPid)
    $listener = if ($Spec.Port -gt 0) { Get-ListeningProcessOnPort -Port $Spec.Port } else { $null }
    $listenerPid = if ($listener) { $listener.OwningProcess } else { $null }
    $listenerCommandLine = $null
    $listenerMatches = $false
    $matchedProcess = $null

    if ($listenerPid) {
        $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
        if ($listenerProcess) {
            $listenerCommandLine = [string]$listenerProcess.CommandLine
            if ($listenerCommandLine -match $Spec.Matcher) {
                $listenerMatches = $true
            }
        }
    }

    if (-not $pidAlive -and -not $listenerMatches -and $Spec.UseMatcherFallback) {
        $matchedProcess = Get-ManagedProcessByMatcher -Matcher $Spec.Matcher
    }

    $process = $null
    if ($pidAlive) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
    } elseif ($listenerMatches -and $listenerPid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
    } elseif ($matchedProcess) {
        $process = $matchedProcess
    }

    $running = [bool]($pidAlive -or $listenerMatches -or $matchedProcess)
    $portOpen = [bool]$listener
    $portConflict = [bool]($listener -and -not $listenerMatches)
    $pidState = if ($managedPid) { if ($pidAlive) { 'alive' } else { 'stale' } } else { 'missing' }
    $listenerState = if (-not $listener) { 'absent' } elseif ($listenerMatches) { 'managed' } else { 'foreign' }
    $owner = if ($portConflict) { 'foreign' } elseif ($running) { 'managed' } else { 'unknown' }
    $runtime = Get-ManagedRuntimeState -Spec $Spec -Process $process -Running $running -PortConflict $portConflict
    $safeAction = 'none'
    if ($listenerState -eq 'foreign') {
        $safeAction = 'blocked_foreign_listener'
    } elseif ($pidState -eq 'stale' -and -not $running) {
        $safeAction = 'remove_stale_pid'
    } elseif (($runtime.state -eq 'stale' -and $owner -eq 'managed') -or (-not $running -and -not $portConflict)) {
        $safeAction = 'restart_managed'
    }

    [pscustomobject]@{
        name = $Spec.Name
        mode = $Spec.Mode
        port = $Spec.Port
        pid_file = $Spec.PidFile
        pid = if ($pidAlive) { $managedPid } elseif ($listenerMatches) { $listenerPid } elseif ($matchedProcess) { $matchedProcess.ProcessId } else { $null }
        running = $running
        port_open = $portOpen
        port_conflict = $portConflict
        stale_pid_file = [bool]($managedPid -and -not $pidAlive)
        owner = $owner
        pid_state = $pidState
        listener_state = $listenerState
        runtime_state = [string]$runtime.state
        runtime_reason = [string]$runtime.reason
        safe_action = $safeAction
        process_started_at = $runtime.process_started_at
        dist_last_write_time = $runtime.dist_last_write_time
        command_line = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
        listener_command_line = if ($listenerCommandLine) { Sanitize-Text $listenerCommandLine } else { $null }
        log_file = $Spec.LogFile
    }
}

