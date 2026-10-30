# Real scheduler/queue proof in a fresh control worktree. Never targets the production control root.
[CmdletBinding()]
param([switch]$FullValidation)
$ErrorActionPreference='Stop'
if(-not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Managed interactive Windows fixture required'}
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$code=Split-Path -Parent $PSScriptRoot
$fixture=New-ConsoleTestFixture -Prefix 'release-broker-fixture'
$control=Join-Path $fixture 'control'
$name='console-mcp-release-fixture-'+[guid]::NewGuid().ToString('N')
$taskCreated=$false;$worktreeCreated=$false
$productionPid=Get-NetTCPConnection -State Listen -LocalPort 3333 | Select-Object -First 1 -ExpandProperty OwningProcess
$productionStarted=(Get-Process -Id $productionPid).StartTime.ToUniversalTime().ToString('o')
$startedAt=[datetime]::UtcNow
try {
 $sha=(& git -C $code rev-parse HEAD).Trim()
 & git -C $code worktree add --detach $control $sha 2>&1 | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot create isolated control worktree'}
 $worktreeCreated=$true
 $entry=Join-Path $code 'tool/dev-console.ps1'
 $launcher=Join-Path $fixture 'launch.ps1'
 $launchText="`$env:CONSOLE_MCP_BEARER_TOKEN=[guid]::NewGuid().ToString('N')`n& '"+$entry.Replace("'","''")+"' -ControlRoot '"+$control.Replace("'","''")+"' watchdog-loop-run`n"
 [IO.File]::WriteAllText($launcher,$launchText)
 $action=New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument ('-NoProfile -File "'+$launcher+'"') -WorkingDirectory $control
 $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::FromMinutes(20))
 $null=Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings
 $taskCreated=$true
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect()
 $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
 $null=$scheduler.GetFolder('\').GetTask($name).RunEx($null,4,$session,$null)
 $brokerPath=Join-Path $control 'var/run/server-control/broker.json'
 $deadline=[datetime]::UtcNow.AddSeconds(30)
 while(-not (Test-Path -LiteralPath $brokerPath) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if(-not (Test-Path -LiteralPath $brokerPath)){throw 'Isolated release broker did not start'}
 $before=Get-Content -Raw $brokerPath | ConvertFrom-Json
 if($before.supported_actions -notcontains 'release-v3' -or $before.windows_session_id -ne $session){throw 'Isolated release broker capability/session mismatch'}
 $status=& $entry -ControlRoot $control release-v3 status | Out-String | ConvertFrom-Json
 if(-not $status.result.ok -or $status.result.status -cne 'RELEASE_NO_TRANSACTION'){throw 'Real release queue status failed'}
 $validated=$false;$validationResult=$null;$maxHeartbeatAge=0;$validationPulses=0;$lastSequence=$before.heartbeat_sequence
 if($FullValidation){
  $submitted=& $entry -ControlRoot $control release-v3 validate $code $sha --submit | Out-String | ConvertFrom-Json
  if(-not $submitted.submitted){throw 'Validation request not submitted'}
  $response=Join-Path $control ('var/run/server-control/results/'+$submitted.correlation_id+'.json')
  $deadline=[datetime]::UtcNow.AddMinutes(12)
  while(-not (Test-Path -LiteralPath $response) -and [datetime]::UtcNow -lt $deadline){
   $during=Get-Content -Raw $brokerPath | ConvertFrom-Json
   $age=([datetime]::UtcNow-([datetime]$during.heartbeat_at).ToUniversalTime()).TotalSeconds
   $maxHeartbeatAge=[math]::Max($maxHeartbeatAge,$age)
   if($during.heartbeat_sequence -gt $lastSequence){$validationPulses++;$lastSequence=$during.heartbeat_sequence}
   Start-Sleep -Seconds 1
  }
  if(-not (Test-Path -LiteralPath $response)){throw 'Broker validation exceeded fixture deadline'}
  $validationResult=(Get-Content -Raw $response | ConvertFrom-Json).result
  $validated=$validationResult.ok -and $validationResult.status -ceq 'RELEASE_VALIDATED' -and $maxHeartbeatAge -lt 8 -and $validationPulses -gt 5
 }
 $after=Get-Content -Raw $brokerPath | ConvertFrom-Json
 $nowPid=Get-NetTCPConnection -State Listen -LocalPort 3333 | Select-Object -First 1 -ExpandProperty OwningProcess
 if($nowPid -ne $productionPid -or (Get-Process -Id $nowPid).StartTime.ToUniversalTime().ToString('o') -cne $productionStarted){throw 'Production runtime changed during isolated broker test'}
 $result=@{ok=(!$FullValidation -or $validated);status='RELEASE_V3_REAL_BROKER_OBSERVED';sha=$sha;session=$session;brokerPid=$after.pid;
   queueStatusPassed=$true;heartbeatAdvanced=($after.heartbeat_sequence -gt $before.heartbeat_sequence);fullValidationPassed=$validated;
   validation=$validationResult;maxHeartbeatAgeSeconds=$maxHeartbeatAge;heartbeatsObservedDuringValidation=$validationPulses;productionPid=$nowPid;productionChanged=$false;elapsedSeconds=([datetime]::UtcNow-$startedAt).TotalSeconds}
 if(-not $result.ok){throw ('Broker validation failed: '+$validationResult.status)}
 $result | ConvertTo-Json -Depth 8
} finally {
 if($taskCreated){Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $name -Confirm:$false}
 # Retain the isolated worktree and private signed evidence for diagnosis/audit, including on failure.
 @{retainedFixture=$fixture;controlWorktree=$control;worktreeCreated=$worktreeCreated;productionArtifactsDeleted=$false} | ConvertTo-Json -Compress
}
