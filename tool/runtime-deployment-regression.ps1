$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-runtime-deployment.ps1')
$savedSessionCheck = ${function:Assert-ConsoleDeploymentSession}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-deployment-' + [guid]::NewGuid().ToString('N'))
$script:ControlRootPath = Join-Path $fixture 'active'
$candidate = Join-Path $fixture 'candidate'
$script:RunDir = Join-Path $fixture 'control'
. (Join-Path $PSScriptRoot 'dev-console.d/85-session-relay.ps1')
New-Item -ItemType Directory -Force -Path $ControlRootPath,(Get-DeploymentDirectory) | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'fixture-hooks') | Out-Null
& git -C $ControlRootPath init -q
Set-Content (Join-Path $ControlRootPath 'source.txt') 'baseline'
& git -C $ControlRootPath add source.txt
# This synthetic text-only repository is not a platform PHP consumer. Its fixture
# commit must not invoke the host's unrelated global PHP pre-commit hook.
$fixtureHooks = 'core.hooksPath=' + (Join-Path $fixture 'fixture-hooks')
& git -C $ControlRootPath -c $fixtureHooks -c user.name=Fixture -c user.email=dev@smartresponsor.com commit -qm fixture
if ($LASTEXITCODE -ne 0) { throw 'Fixture commit failed' }
& git -C $ControlRootPath worktree add --detach $candidate HEAD 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Fixture worktree failed' }
foreach ($path in @($ControlRootPath,$candidate)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $path 'dist') | Out-Null
    Set-Content (Join-Path $path 'dist/index.js') '// fixture build'
}
# Ignore generated files without changing source; keep deliberately dirty active work.
Add-Content (Join-Path $ControlRootPath '.git/info/exclude') 'dist/'
Add-Content (Join-Path $ControlRootPath '.git/info/exclude') 'var/'
Add-Content (Join-Path $ControlRootPath '.git/info/exclude') 'node_modules/'
New-Item -ItemType Directory -Path (Join-Path $candidate 'node_modules'),(Join-Path $ControlRootPath 'node_modules') | Out-Null
Set-Content (Join-Path $ControlRootPath 'source.txt') 'uncommitted user change'
Set-Content (Join-Path $ControlRootPath 'staged.txt') 'staged user work'
& git -C $ControlRootPath add staged.txt
Set-Content (Join-Path $ControlRootPath 'untracked.txt') 'untracked user work'
$preflight = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1') -WorkspacePath $ControlRootPath -CandidatePath $candidate -ExpectedCommit (Get-DeploymentGit $candidate @('rev-parse','HEAD')) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $preflight.ok) { throw 'Dirty active checkout blocked isolated preflight' }
$script:Root = $ControlRootPath
$baseline = Get-ConsoleReleaseFingerprint $ControlRootPath
$rollback = Copy-ConsoleRollbackRelease $ControlRootPath ([guid]::NewGuid().ToString('N'))
if ((Get-Content (Join-Path $rollback 'untracked.txt')) -ne 'untracked user work') { throw 'Rollback snapshot lost untracked work' }
$script:events = [System.Collections.Generic.List[string]]::new()
$script:failStart = $false
$script:failHealth = $false
function Assert-ConsoleDeploymentSession {}
function Stop-UnifiedConsoleRuntime { $script:events.Add("stop:$Root") }
function Start-UnifiedConsoleRuntime {
    $script:events.Add("start:$Root")
    if ($script:failStart -and $Root -eq $candidate) { throw 'fixture startup failure' }
}
function Test-ConsoleDeploymentHealth {
    $script:events.Add("health:$Root")
    return [pscustomobject]@{ok=(-not ($script:failHealth -and $Root -eq $candidate));archive_available=$true}
}
function New-FixtureReceipt {
    $script:Root = $ControlRootPath
    $script:events.Clear()
    $id = [guid]::NewGuid().ToString('N')
    $receipt = [pscustomobject]@{
        id=$id;phase='validated';candidate=$candidate;expected_commit=(Get-DeploymentGit $candidate @('rev-parse','HEAD'))
        candidate_fingerprint=(Get-ConsoleReleaseFingerprint $candidate)
        previous_runtime=$ControlRootPath;previous_runtime_fingerprint=(Get-ConsoleReleaseFingerprint $ControlRootPath)
        previous=$rollback;previous_fingerprint=(Get-ConsoleReleaseFingerprint $rollback)
        active_fingerprint=$baseline;expires_at=(Get-Date).ToUniversalTime().AddMinutes(5).ToString('o')
    }
    Write-ServerControlJsonAtomically (Join-Path (Get-DeploymentDirectory) "$id.json") $receipt
    return $receipt
}
function Invoke-Fixture($receipt) {
    Invoke-ConsoleDeployment $receipt.id @{deadline_at=(Get-Date).ToUniversalTime().AddMinutes(5).ToString('o')}
}
function Assert-True($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$success = New-FixtureReceipt
$result = Invoke-Fixture $success
Assert-True ($result.ok -and $result.status -eq 'DEPLOYMENT_COMMITTED') 'Successful switch failed'
Assert-True (($events -join '|') -eq "stop:$ControlRootPath|start:$candidate|health:$candidate") 'Unexpected execution order'
$replayBlocked = $false
try { Invoke-Fixture $success | Out-Null } catch { $replayBlocked = $true }
Assert-True $replayBlocked 'Consumed receipt accepted'

foreach ($failure in @('start','health')) {
    $receipt = New-FixtureReceipt
    $script:failStart = $failure -eq 'start'
    $script:failHealth = $failure -eq 'health'
    $result = Invoke-Fixture $receipt
    Assert-True ($result.status -eq 'DEPLOYMENT_ROLLED_BACK' -and $Root -eq $rollback) "$failure did not roll back"
    Assert-True ($events.Contains("start:$rollback") -and $events.Contains("health:$rollback")) 'Rollback was not health checked'
}
$script:failStart = $false; $script:failHealth = $false
$tampered = New-FixtureReceipt
Add-Content (Join-Path $candidate 'dist/index.js') '// changed after validation'
$blocked = $false
try { Invoke-Fixture $tampered | Out-Null } catch { $blocked = $true }
Assert-True ($blocked -and $events.Count -eq 0) 'Tampered candidate mutated runtime'

$interrupted = New-FixtureReceipt
$interrupted.phase = 'switching'
Write-ServerControlJsonAtomically (Join-Path (Get-DeploymentDirectory) 'transaction.json') $interrupted
Set-ConsoleRelease $candidate
Restore-InterruptedConsoleDeployment
Assert-True ($Root -eq $rollback -and $events.Contains("start:$rollback")) 'Interrupted switch not recovered'
Assert-True ((Get-ConsoleReleaseFingerprint $ControlRootPath) -eq $baseline) 'Active dirty work changed'

$expired = New-FixtureReceipt
$expired.expires_at = (Get-Date).ToUniversalTime().AddSeconds(-1).ToString('o')
Write-ServerControlJsonAtomically (Join-Path (Get-DeploymentDirectory) "$($expired.id).json") $expired
$blocked = $false
try { Invoke-Fixture $expired | Out-Null } catch { $blocked = $true }
Assert-True ($blocked -and $events.Count -eq 0) "Expired receipt guard failed: blocked=$blocked events=$($events -join ',') expires=$($expired.expires_at)"

${function:Assert-ConsoleDeploymentSession} = $savedSessionCheck
function Get-ConsoleSessionReport { return @{active_console=@{id=-1}} }
$blocked = $false
try { Assert-ConsoleDeploymentSession } catch { $blocked = $true }
Assert-True $blocked 'Wrong Windows session accepted'
function Ensure-Directories {}
function Get-WatchdogLoopProcessState { return @{running=$true} }
function Get-ServerControlBrokerIdentity { return @{supported_actions=@('start-server','stop-server')} }
$unsupported = Request-ServerControlAction -Action deploy-release -DeploymentId $expired.id
Assert-True ($unsupported.status -eq 'BROKER_DEPLOYMENT_UNSUPPORTED' -and -not $unsupported.runtime_mutated) 'Old broker was not rejected before runtime mutation'
Write-Output "DEPLOYMENT_REGRESSION_PASS (switch, startup/health rollback, crash recovery, tamper, replay, expiry, dirty preservation, session guard); fixtures retained: $fixture"
