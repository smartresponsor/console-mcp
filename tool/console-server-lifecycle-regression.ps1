# Regression coverage for the authoritative stop-server lifecycle in
# tool/dev-console.d/90-server-lifecycle.ps1.
#
# This exercises the pure/injectable process-selection and verification logic with synthetic data -
# it never starts, stops, or otherwise touches a real process. Root cause under test: stop-server used
# to report success even when the old server PID never actually died (Invoke-ProcessKill swallowed
# every Stop-Process error, and the old PID's still-matching listener made Get-ManagedProcessState
# keep reporting it as "running", so nothing downstream ever noticed).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Load function definitions only. 'watchdog-loop-status' just reads a state file - no process is
# started, stopped, or otherwise touched by loading the script this way.
. (Join-Path $root 'tool\dev-console.ps1') watchdog-loop-status | Out-Null

$script:failures = @()
$script:passCount = 0

function Assert-True {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if ($Condition) {
        $script:passCount += 1
    } else {
        $script:failures += $Message
    }
}

function Assert-Equal {
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)][string]$Message)
    if ("$Expected" -eq "$Actual") {
        $script:passCount += 1
    } else {
        $script:failures += "$Message (expected=[$Expected] actual=[$Actual])"
    }
}

$chatgptMatcher = (Get-ChatgptSpec).Matcher
$codexMatcher = (Get-CodexSpec).Matcher

function New-Rec {
    param($Source, $SpecName, $Port, $Matcher, $ProcessId, $Exe = 'node.exe', $Cmd = $null)
    if ($null -eq $Cmd) {
        $Cmd = '"C:\Program Files\nodejs\node.exe" --enable-source-maps "' + (Join-Path $root 'dist/index.js') + '"'
    }
    return New-ConsoleServerCandidateRecord -Source $Source -SpecName $SpecName -Port $Port -Matcher $Matcher -ProcessId $ProcessId -ExecutableName $Exe -CommandLine $Cmd -ExecutablePath 'C:\Program Files\nodejs\node.exe' -CreationTime '2026-07-12T00:00:00Z'
}

# --- Scenario 1: PID-file correct, listener PID matches -------------------------------------------
$records = @(
    (New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 100),
    (New-Rec 'pid_file' 'chatgpt-oauth' 3333 $chatgptMatcher 100)
)
$merged = Merge-ConsoleServerCandidateSources -Records $records
Assert-Equal 1 $merged.Count 'Scenario 1: single merged entry for matching listener+pid_file'
Assert-True ([bool]$merged[0].identity_confirmed) 'Scenario 1: identity confirmed when listener and pid_file agree'
Assert-True ([bool]$merged[0].listener_owner) 'Scenario 1: listener_owner flag set'

# --- Scenario 2: PID-file stale, listener owned by a different confirmed PID -----------------------
$staleRecord = New-ConsoleServerCandidateRecord -Source 'pid_file' -SpecName 'codex-bearer' -Port 3334 -Matcher $codexMatcher -ProcessId 900 -ExecutableName $null -CommandLine $null -ExecutablePath $null -CreationTime $null
$liveListenerRecord = New-Rec 'listener' 'codex-bearer' 3334 $codexMatcher 901
$merged = Merge-ConsoleServerCandidateSources -Records @($staleRecord, $liveListenerRecord)
$stale = $merged | Where-Object { $_.pid -eq 900 }
$live = $merged | Where-Object { $_.pid -eq 901 }
Assert-True (-not $stale.identity_confirmed) 'Scenario 2: stale pid_file entry (dead/unconfirmed) never gets identity_confirmed on its own'
Assert-True ([bool]$live.identity_confirmed) 'Scenario 2: the actual listener owner is identity_confirmed'
Assert-True ([bool]$live.listener_owner) 'Scenario 2: live listener outranks the stale pid_file record'

# --- Scenario 3: PID-file absent, server found only by listener -----------------------------------
$merged = Merge-ConsoleServerCandidateSources -Records @((New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 555))
Assert-Equal 1 $merged.Count 'Scenario 3: listener-only candidate produces exactly one entry'
Assert-True ([bool]$merged[0].identity_confirmed) 'Scenario 3: listener-only candidate is identity_confirmed'

# --- Scenario 4: one process serving both ports ----------------------------------------------------
$merged = Merge-ConsoleServerCandidateSources -Records @(
    (New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 777),
    (New-Rec 'listener' 'codex-bearer' 3334 $codexMatcher 777)
)
Assert-Equal 1 $merged.Count 'Scenario 4: one process on two ports merges into a single candidate'
Assert-Equal 2 $merged[0].ports.Count 'Scenario 4: merged candidate lists both ports'

# --- Scenario 5: two separate processes on separate ports ------------------------------------------
$merged = Merge-ConsoleServerCandidateSources -Records @(
    (New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 111),
    (New-Rec 'listener' 'codex-bearer' 3334 $codexMatcher 222)
)
Assert-Equal 2 $merged.Count 'Scenario 5: two distinct processes produce two distinct candidates'
Assert-True (($merged | Where-Object { $_.identity_confirmed }).Count -eq 2) 'Scenario 5: both distinct processes are confirmed independently'

# --- Scenario 6: a foreign (non-node) process owns one of our ports --------------------------------
$foreign = New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 333 -Exe 'python.exe' -Cmd 'python.exe some_other_app.py'
$merged = Merge-ConsoleServerCandidateSources -Records @($foreign)
Assert-True (-not $merged[0].identity_confirmed) 'Scenario 6: a foreign non-node listener is never identity_confirmed'

# --- Scenario 7: an unrelated node process (different entrypoint/invocation) is not treated as ours -
$otherNodeApp = New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 444 -Exe 'node.exe' -Cmd '"C:\Program Files\nodejs\node.exe" server.js'
$merged = Merge-ConsoleServerCandidateSources -Records @($otherNodeApp)
Assert-True (-not $merged[0].identity_confirmed) 'Scenario 7: a node.exe process not invoking dist/index.js or npm run start is never identity_confirmed'

# --- Scenario 8: wrapper PowerShell PID must never be confused with the child Node PID -------------
$wrapper = New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 999 -Exe 'pwsh.exe' -Cmd 'pwsh.exe -File dist/index.js'
$merged = Merge-ConsoleServerCandidateSources -Records @($wrapper)
Assert-True (-not $merged[0].identity_confirmed) 'Scenario 8: a non-node executable is rejected even if its command line mentions the entrypoint'

# --- Scenario 9 / 11: graceful stop fails, force fallback is required; if it still survives, that ---
# --- must surface as survived=$true rather than a false "stopped OK".                              --
$aliveSequence = [ordered]@{ calls = 0 }
$testAliveMostlyDead = {
    param($id)
    $aliveSequence.calls += 1
    return ($aliveSequence.calls -le 2)
}
$stop = Invoke-ConsoleServerGracefulThenForceStop -ProcessId 12345 -GraceSeconds 0 -ForceTimeoutSeconds 0 `
    -TestAlive $testAliveMostlyDead `
    -InvokeGraceful { param($id) } `
    -InvokeForce { param($id) } `
    -Sleeper { param($ms) }
Assert-True $stop.graceful_attempted 'Scenario 9: graceful stop is attempted first'
Assert-True $stop.force_attempted 'Scenario 9: force fallback runs when graceful stop does not clear the PID in time'
Assert-True (-not $stop.survived) 'Scenario 9: process that dies after the force fallback is not reported as survived'

$neverDies = { param($id) $true }
$stopSurvived = Invoke-ConsoleServerGracefulThenForceStop -ProcessId 54321 -GraceSeconds 0 -ForceTimeoutSeconds 0 `
    -TestAlive $neverDies `
    -InvokeGraceful { param($id) } `
    -InvokeForce { param($id) } `
    -Sleeper { param($ms) }
Assert-True $stopSurvived.survived 'Scenario 11: a PID that never dies is explicitly reported as survived=$true (never silently treated as stopped)'

# Stop-ConsoleServerConfirmedProcesses must never call the killer on an unconfirmed candidate.
$killAttempted = [ordered]@{ count = 0 }
$unconfirmedCandidate = [pscustomobject]@{ pid = 42; identity_confirmed = $false; ports = @(3333); spec_names = @('chatgpt-oauth') }
$results = Stop-ConsoleServerConfirmedProcesses -Candidates @($unconfirmedCandidate)
Assert-True ([bool]$results[0].skipped) 'Scenario 6/7/8 follow-through: unconfirmed candidates are skipped, not killed'
Assert-Equal 'identity_not_confirmed' $results[0].reason 'Unconfirmed candidate carries an explicit skip reason'

# --- Scenario 12: new PID equals old PID (no real replacement happened) -----------------------------
$before = @([pscustomobject]@{ port = 3333; pid = 100 }, [pscustomobject]@{ port = 3334; pid = 200 })
$sameAfter = @([pscustomobject]@{ port = 3333; pid = 100 }, [pscustomobject]@{ port = 3334; pid = 201 })
Assert-True (-not (Test-ConsoleServerPidReplaced -Ports @(3333, 3334) -BeforeListeners $before -AfterListeners $sameAfter)) 'Scenario 12: pid_replaced is false when even one port kept its old PID'

# --- Scenario 14 (selection half): a genuine replacement on every port is recognized -----------------
$newAfter = @([pscustomobject]@{ port = 3333; pid = 301 }, [pscustomobject]@{ port = 3334; pid = 302 })
Assert-True (Test-ConsoleServerPidReplaced -Ports @(3333, 3334) -BeforeListeners $before -AfterListeners $newAfter) 'Scenario 14: pid_replaced is true when every port has a new owner'

# --- Port-release waiting: old PID still owns a port ------------------------------------------------
$stillOwnedProbe = { param($port) [pscustomobject]@{ OwningProcess = 100 } }
$release = Wait-ConsoleServerPortsReleasedFromPids -Ports @(3333) -OldPids @(100) -TimeoutSeconds 0 -ListenerProbe $stillOwnedProbe -Sleeper { param($ms) }
Assert-True (-not $release.ok) 'Old PID still owning the port after stop is reported as not released'

$releasedProbe = { param($port) [pscustomobject]@{ OwningProcess = 999 } }
$release = Wait-ConsoleServerPortsReleasedFromPids -Ports @(3333) -OldPids @(100) -TimeoutSeconds 5 -ListenerProbe $releasedProbe -Sleeper { param($ms) }
Assert-True ([bool]$release.ok) 'A different (new) PID owning the port counts as released from the old PID'

# --- Scenario 15: ports discovery never includes browser/DevTools debugging ports -------------------
$ports = Get-ConsoleServerPorts
Assert-Equal 2 $ports.Count 'Server ports discovery yields exactly the two managed endpoints'
Assert-True ($ports -contains 3333) 'Server ports include the chatgpt-oauth endpoint (3333)'
Assert-True ($ports -contains 3334) 'Server ports include the codex-bearer endpoint (3334)'
Assert-True (-not ($ports -contains 9222)) 'Server ports discovery never includes the Edge/Chrome debugging port 9222'
Assert-True (-not ($ports -contains 9223)) 'Server ports discovery never includes the Edge/Chrome debugging port 9223'

$devtools = New-Rec 'listener' 'chatgpt-oauth' 3333 $chatgptMatcher 8080 -Exe 'msedge.exe' -Cmd 'msedge.exe --remote-debugging-port=9222'
$merged = Merge-ConsoleServerCandidateSources -Records @($devtools)
Assert-True (-not $merged[0].identity_confirmed) 'Scenario 15: a browser/DevTools process is never identity_confirmed even if seen on a managed port'

Write-Output ''
Write-Output "console-server-lifecycle-regression: $($script:passCount) passed, $($script:failures.Count) failed"
if ($script:failures.Count -gt 0) {
    foreach ($failure in $script:failures) {
        Write-Output "FAIL: $failure"
    }
    Write-Output ''
    Write-Output 'NOTE: scenarios 10 (watchdog respawn race) and 13/14 (new-server health verification) are'
    Write-Output 'integration-level behavior validated by a live controlled stop/restart, not by this synthetic'
    Write-Output 'unit-data run - see the final report for that verification.'
    exit 1
}

Write-Output ''
Write-Output 'NOTE: scenarios 10 (watchdog respawn race) and 13/14 (new-server health verification) are'
Write-Output 'integration-level behavior validated by a live controlled stop/restart, not by this synthetic'
Write-Output 'unit-data run - see the final report for that verification.'
