$ErrorActionPreference='Stop'
$name='SmartResponsor Atlassing Quality Atlas'
$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop
if ($task.State -eq 'Running') {Stop-ScheduledTask -TaskName $name -ErrorAction Stop}
Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
$after=Get-ScheduledTask -TaskName $name -ErrorAction Stop
[pscustomobject]@{task=$name;before=[string]$task.State;after=[string]$after.State;disabled=($after.State -eq 'Disabled')} | ConvertTo-Json
if ($after.State -ne 'Disabled') {exit 1}
