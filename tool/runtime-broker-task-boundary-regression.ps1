[CmdletBinding()]
param([string]$Mode='test',[string]$FixtureRoot='')
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Windows interactive task boundary probe only'}
if($Mode -eq 'child'){
 $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
 $info.ArgumentList.Add('-e');$info.ArgumentList.Add('setInterval(()=>{},1000)')
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $child=[Diagnostics.Process]::Start($info)
 @{pid=$child.Id;started=$child.StartTime.ToUniversalTime().ToString('o');actionPid=$PID} | ConvertTo-Json | Set-Content (Join-Path $FixtureRoot 'child.json')
 Start-Sleep -Seconds 90
 exit
}
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'broker-task-boundary'
$name='console-mcp-boundary-'+[guid]::NewGuid().ToString('N')
$child=$null
$verifiedChild=$false
try {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $action=New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument ('-NoProfile -File "'+$PSCommandPath+'" -Mode child -FixtureRoot "'+$fixture+'"')
 $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::FromMinutes(2))
 $null=Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings
 $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
 if($session -le 0){throw 'Interactive fixture session required'}
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect()
 $null=$scheduler.GetFolder('\').GetTask($name).RunEx($null,4,$session,$null)
 $deadline=[datetime]::UtcNow.AddSeconds(20)
 while(-not (Test-Path (Join-Path $fixture 'child.json')) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if(-not (Test-Path (Join-Path $fixture 'child.json'))){throw 'Fixture task did not launch'}
 $record=Get-Content -Raw (Join-Path $fixture 'child.json') | ConvertFrom-Json -DateKind String
 $child=Get-Process -Id $record.pid
 if($child.StartTime.ToUniversalTime().ToString('o') -cne $record.started){throw 'Fixture child identity changed'}
 $verifiedChild=$true
 Stop-ScheduledTask -TaskName $name
 Start-Sleep -Seconds 2
 $child.Refresh()
 @{ok=$true;status='BROKER_TASK_STOP_BOUNDARY_OBSERVED';childSurvivedTaskStop=(-not $child.HasExited);session=$session;productionChanged=$false} | ConvertTo-Json
}finally{
 if($verifiedChild -and $child -and -not $child.HasExited){$child.Kill();$child.WaitForExit()}
 if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $name -Confirm:$false}
 Remove-ConsoleTestFixture $fixture
}
