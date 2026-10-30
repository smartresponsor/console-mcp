$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'validation-process'
$RunDir=$fixture
. (Join-Path $PSScriptRoot 'dev-console.d/85-session-relay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-validation-process.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1')
$state=Join-Path $fixture 'broker.json'
function Get-ServerControlBrokerIdentity {Get-Content -LiteralPath $state -Raw | ConvertFrom-Json}
function Write-ServerControlBrokerIdentity($Identity){$Identity | ConvertTo-Json | Set-Content -LiteralPath $state}
try {
 $outer=[pscustomobject]@{pid=$PID;generation=[guid]::NewGuid().ToString('N');heartbeat_sequence=0;heartbeat_at=''}
 Write-ServerControlBrokerIdentity $outer
 $script:pulses=0
 $childScript=Join-Path $fixture 'child.ps1';$receipt=Join-Path $fixture 'child.json'
 [IO.File]::WriteAllText($childScript,'param([string]$Receipt,[int]$Seconds=2); [IO.File]::WriteAllText($Receipt,[string]$PID); Start-Sleep -Seconds $Seconds; "fixture completed"')
 $result=Invoke-ReleaseV3ValidationProcess -Script $childScript -Arguments @('-Receipt',$receipt) -WorkingDirectory $fixture -Log (Join-Path $fixture 'step.log') -Pulse {$script:pulses++;Update-ServerControlBrokerHeartbeat (Get-ServerControlBrokerIdentity)}
 if($result.exitCode -ne 0 -or $script:pulses -lt 3 -or $result.stdout -notmatch 'fixture completed'){throw 'Validation process lost heartbeat or result'}
 $sequence=(Get-ServerControlBrokerIdentity).heartbeat_sequence
 $next=Update-ServerControlBrokerHeartbeat $outer
 if($next.heartbeat_sequence -le $sequence){throw 'Outer broker reset the progress sequence'}
 $foreign=[pscustomobject]@{pid=$PID;generation='foreign';heartbeat_sequence=0;heartbeat_at=''}
 try{$null=Update-ServerControlBrokerHeartbeat $foreign;throw 'Foreign identity wrote heartbeat'}catch{if($_.Exception.Message -ne 'SERVER_CONTROL_BROKER_IDENTITY_CHANGED'){throw}}
 try{
  $null=Invoke-ReleaseV3ValidationProcess -Script $childScript -Arguments @('-Receipt',$receipt,'-Seconds','30') -WorkingDirectory $fixture -Log (Join-Path $fixture 'timeout.log') -TimeoutSeconds 1 -Pulse {}
  throw 'Hung validation was accepted'
 }catch{if($_.Exception.Message -ne 'RELEASE_VALIDATION_PROCESS_TIMEOUT'){throw}}
 $childId=[int](Get-Content $receipt -Raw)
 if(Get-Process -Id $childId -ErrorAction SilentlyContinue){throw 'Timed-out validation child survived'}
 $source=Join-Path $fixture 'source';$null=[IO.Directory]::CreateDirectory($source)
 $hooks=Join-Path $fixture 'empty-fixture-hooks';$null=[IO.Directory]::CreateDirectory($hooks)
 & git -C $source init -q
 & git -C $source -c core.hooksPath=$hooks -c user.name=Fixture -c user.email=dev@smartresponsor.com -c commit.gpgsign=false commit -q --allow-empty -m fixture
 if($LASTEXITCODE -ne 0){throw 'Cannot create source identity fixture'}
 $sha=(& git -C $source rev-parse HEAD).Trim()
 & git -C $source update-ref refs/remotes/origin/master $sha
 Assert-ReleaseV3CanonicalSource $source $sha
 Set-Content (Join-Path $source 'dirty.txt') 'preserve'
 try{Assert-ReleaseV3CanonicalSource $source $sha;throw 'Dirty source validated'}catch{if($_.Exception.Message -ne 'RELEASE_SOURCE_NOT_CLEAN'){throw}}
 try{Assert-ReleaseV3CanonicalSource $source ('0'*40);throw 'Wrong source SHA validated'}catch{if($_.Exception.Message -ne 'RELEASE_SHA_MISMATCH'){throw}}
 @{ok=$true;status='VALIDATION_PROCESS_REGRESSION_PASS';heartbeatPulses=$script:pulses;timeoutChildStopped=$true;productionChanged=$false}|ConvertTo-Json
}finally{Remove-ConsoleTestFixture $fixture}
