$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$watchdogFile = Join-Path $root 'tool\dev-console.d\40-watchdog.ps1'
$recoveryFile = Join-Path $root 'tool\dev-console.d\21-browser-recovery.ps1'

# AST-only extraction: pull the exact function text out of the real production files instead of
# dot-sourcing them wholesale (dev-console.d\40-watchdog.ps1 and \21-browser-recovery.ps1 pull in
# module-level dependencies - Get-WatchdogLoopHeartbeatState's broker/heartbeat plumbing, real
# Get-Process/Get-CimInstance calls, Write-StateArtifact disk writes - that a unit test has no
# business exercising). This proves the change against the shipped function bodies, not a
# reimplementation of them.
function Get-FunctionSourceText {
    param([string]$Path, [string]$Name)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    $funcAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name }, $true) | Select-Object -First 1
    if (-not $funcAst) { throw "Function '$Name' not found in $Path" }
    return $funcAst.Extent.Text
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ("$Expected" -ne "$Actual") { throw "ASSERTION FAILED: $Message (expected='$Expected' actual='$Actual')" }
}

# ---------------------------------------------------------------------------------------------
# Scenario (a) + (b): Get-SystemReadyState - browser_connected must be automation-only, and a
# missing visible window must never appear as a NOT_READY reason.
# ---------------------------------------------------------------------------------------------
Invoke-Expression (Get-FunctionSourceText -Path $watchdogFile -Name 'Get-SystemReadyState')

$ChatgptOrigin = 'https://chatgpt.com'
$script:BrowserFixture = $null

function Get-WatchdogLoopProcessState { [pscustomobject]@{ running = $true; pid = 4242; pid_file = 'stub'; stale_pid_file = $false } }
function Get-WatchdogLoopHeartbeatState { param($Loop) [pscustomobject]@{ ok = $true; status = 'HEARTBEAT_FRESH' } }
function Get-BrowserStackHealthReport { return $script:BrowserFixture }
function Get-ManagedProcessState { param($Spec) [pscustomobject]@{ running = $true; port_open = $true; port_conflict = $false } }
function Get-ChatgptSpec { [pscustomobject]@{ Name = 'stub-chatgpt' } }
function Invoke-ChatgptSmoke { param($Origin, $Label, [switch]$Quiet) [pscustomobject]@{ ok = $true; metadata_ok = $true; mcp_unauthorized = $true; mcp_status = 401 } }
function Get-WatchdogLaunchFailureClassification { param($Loop, $Heartbeat, $Browser, $Oauth) [pscustomobject]@{ reason = 'STUB_CLASSIFICATION'; detail = $null; next_action = 'stub' } }

function New-BrowserFixture {
    param(
        [bool]$CdpOk = $true,
        [int]$ChatgptTargetCount = 1,
        [bool]$HasActiveConsole = $true,
        [bool]$VisibleWindow = $true
    )
    $effectiveOk = [bool]($CdpOk -and $ChatgptTargetCount -gt 0 -and $VisibleWindow)
    return [pscustomobject]@{
        ok = $effectiveOk
        status = if ($effectiveOk) { 'GREEN' } else { 'RED' }
        next_action = if (-not $VisibleWindow) { 'EDGE_VISIBLE_WINDOW_REQUIRED' } elseif (-not $CdpOk) { 'CDP_RECOVERY_REQUIRED' } elseif ($ChatgptTargetCount -le 0) { 'CHATGPT_VISIBLE_PAGE_REQUIRED' } else { 'CHATGPT_SESSION_CLASSIFICATION_REQUIRED' }
        active_console = [pscustomobject]@{ has_active_console = $HasActiveConsole; raw = 'stub' }
        microsoft_edge = [pscustomobject]@{
            interactive_process_count = 1
            visible_window_count = if ($VisibleWindow) { 1 } else { 0 }
            visible_window_detected = $VisibleWindow
            local_visible_window_detected = $VisibleWindow
            desktop_snapshot_visible_detected = $false
        }
        cdp_9223 = [pscustomobject]@{ ok = $CdpOk; browser = 'Edg/999'; error = $null }
        target_inventory = [pscustomobject]@{ ok = $CdpOk; error = $null; chatgpt_target_count = $ChatgptTargetCount }
    }
}

# (a) CDP ok, ChatGPT target present, active console present, browser window NOT visible ->
# browser_connected must be true and the missing window must not block overall SYSTEM_READY.
$script:BrowserFixture = New-BrowserFixture -CdpOk $true -ChatgptTargetCount 2 -HasActiveConsole $true -VisibleWindow $false
$stateA = Get-SystemReadyState
Assert-True $stateA.checks.browser_connected.ok "scenario (a): browser_connected must be true when automation signals are healthy even without a visible window"
Assert-Equal 'BROWSER_AUTOMATION_READY' $stateA.checks.browser_connected.status "scenario (a): browser_connected status"
Assert-True (-not $stateA.browser_visible.ok) "scenario (a): browser_visible.ok must reflect the missing window"
Assert-Equal 'EDGE_WINDOW_NOT_VISIBLE' $stateA.browser_visible.status "scenario (a): browser_visible.status"
Assert-True (-not [bool]$stateA.browser_visible.repair_required) "scenario (a): browser_visible.repair_required must default to false (non-blocking)"
Assert-True $stateA.ok "scenario (a): overall SYSTEM_READY must be true with all other checks green despite no visible window"
Assert-Equal 'SYSTEM_READY' $stateA.status "scenario (a): overall status"
Assert-True (@($stateA.not_ready) -notcontains 'browser_connected') "scenario (a): browser_connected must not be in not_ready"
Assert-True ($stateA.checks.PSObject.Properties.Name -notcontains 'browser_visible') "scenario (a): browser_visible must not be a gating key inside checks"
$stateAJson = ($stateA | ConvertTo-Json -Depth 10 -Compress)
if ($stateAJson -match 'EDGE_VISIBLE_WINDOW_REQUIRED') { throw "ASSERTION FAILED: scenario (a): EDGE_VISIBLE_WINDOW_REQUIRED must not leak into SYSTEM_READY output when automation is healthy" }

# (b) CDP not responding -> browser_connected must be false regardless of visible-window state,
# and the overall system must be NOT_READY for the real reason (CDP), not the window.
$script:BrowserFixture = New-BrowserFixture -CdpOk $false -ChatgptTargetCount 0 -HasActiveConsole $true -VisibleWindow $true
$stateB = Get-SystemReadyState
Assert-True (-not $stateB.checks.browser_connected.ok) "scenario (b): browser_connected must be false when CDP is not responding"
Assert-Equal 'CDP_RECOVERY_REQUIRED' $stateB.checks.browser_connected.next_action "scenario (b): browser_connected.next_action should point at CDP, not the window"
Assert-True $stateB.browser_visible.ok "scenario (b): browser_visible.ok reflects the (irrelevant, but true) visible window in this fixture"
Assert-True (-not $stateB.ok) "scenario (b): overall system must be NOT_READY"
Assert-True (@($stateB.not_ready) -contains 'browser_connected') "scenario (b): browser_connected must be listed in not_ready"

Write-Output 'Get-SystemReadyState scenarios (a)/(b): PASS'

# ---------------------------------------------------------------------------------------------
# Get-WatchdogLaunchFailureClassification: a browser that is automation-healthy but merely lacks
# a visible window must not be classified as a browser launch failure.
# ---------------------------------------------------------------------------------------------
Invoke-Expression (Get-FunctionSourceText -Path $watchdogFile -Name 'Get-WatchdogLaunchFailureClassification')

$Root = Join-Path $env:TEMP 'system-ready-browser-visible-regression-noexist'
function Get-ConsoleSessionReport { [pscustomobject]@{ ok = $true; reasons = @() } }
function Get-AutologonReport { [pscustomobject]@{ ok = $true; reasons = @() } }

$loopStub = [pscustomobject]@{ running = $true; pid = 1; pid_file = 'stub'; stale_pid_file = $false }
$heartbeatStub = [pscustomobject]@{ ok = $true }
$notVisibleButAutomationOk = New-BrowserFixture -CdpOk $true -ChatgptTargetCount 3 -HasActiveConsole $true -VisibleWindow $false

$classification = Get-WatchdogLaunchFailureClassification -ConsoleSession (Get-ConsoleSessionReport) -Autologon (Get-AutologonReport) -Loop $loopStub -Heartbeat $heartbeatStub -Browser $notVisibleButAutomationOk -Oauth ([pscustomobject]@{ ok = $true })
Assert-True ($classification.reason -ne 'BROWSER_LAUNCH_TIMEOUT') "classification: automation-healthy browser with no visible window must not classify as BROWSER_LAUNCH_TIMEOUT (got reason=$($classification.reason))"

$brokenBrowser = New-BrowserFixture -CdpOk $false -ChatgptTargetCount 0 -HasActiveConsole $true -VisibleWindow $false
$classificationBroken = Get-WatchdogLaunchFailureClassification -ConsoleSession (Get-ConsoleSessionReport) -Autologon (Get-AutologonReport) -Loop $loopStub -Heartbeat $heartbeatStub -Browser $brokenBrowser -Oauth ([pscustomobject]@{ ok = $true })
Assert-Equal 'BROWSER_LAUNCH_TIMEOUT' $classificationBroken.reason "classification: a genuinely broken browser (no CDP, no target) must still classify as BROWSER_LAUNCH_TIMEOUT"

Write-Output 'Get-WatchdogLaunchFailureClassification scenario: PASS'

# ---------------------------------------------------------------------------------------------
# Scenario (c): Invoke-BrowserEnsureVisible is an explicitly UI-dependent command and must keep
# requiring a visible window - it must NOT be softened by the SYSTEM_READY change above.
# ---------------------------------------------------------------------------------------------
Invoke-Expression (Get-FunctionSourceText -Path $recoveryFile -Name 'Invoke-BrowserEnsureVisible')

$currentSessionId = (Get-Process -Id $PID).SessionId
$script:EnsureVisibleBrowserFixture = New-BrowserFixture -CdpOk $true -ChatgptTargetCount 1 -HasActiveConsole $true -VisibleWindow $false
function Get-BrowserStackHealthReport { return $script:EnsureVisibleBrowserFixture }
function Get-ConsoleSessionReport { param() [pscustomobject]@{ active_console = [pscustomobject]@{ id = $currentSessionId } } }
function Invoke-BrowserRelaunchVisible { param([string]$Purpose) return $null }
function Start-VisibleEdge { return $null }
function Write-StateArtifact { param($Directory, $Name, $Payload) return $null }
function New-StackOperationId { param([string]$Purpose) return "stub-$Purpose" }
$BrowserStateDir = Join-Path $env:TEMP 'system-ready-browser-visible-regression-state'

$ensureResult = Invoke-BrowserEnsureVisible -Purpose 'regression-test' -PassThroughFailure
Assert-True (-not $ensureResult.ok) "scenario (c): browser-ensure-visible must still fail when no visible window can be produced"
Assert-Equal 'BROWSER_UNHEALTHY' $ensureResult.status "scenario (c): browser-ensure-visible status when visible-window recovery is impossible"
Assert-True $ensureResult.recovery_required "scenario (c): browser-ensure-visible must still recognize EDGE_VISIBLE_WINDOW_REQUIRED as recovery-required"

Write-Output 'Invoke-BrowserEnsureVisible scenario (c): PASS'

Write-Output '{"ok":true,"status":"SYSTEM_READY_BROWSER_VISIBLE_REGRESSION_GREEN"}'
