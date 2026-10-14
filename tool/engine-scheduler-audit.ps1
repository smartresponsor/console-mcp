$ErrorActionPreference='Stop'
$items = @(Get-ScheduledTask | ForEach-Object {
 $t=$_; $info=$null; try {$info=Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop} catch {}
 [pscustomobject]@{name=$t.TaskName;path=$t.TaskPath;state=[string]$t.State;actions=@($t.Actions | ForEach-Object { @{execute=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory} });lastRun=$info.LastRunTime;nextRun=$info.NextRunTime;lastResult=$info.LastTaskResult;triggers=@($t.Triggers | ForEach-Object {@{enabled=$_.Enabled;start=$_.StartBoundary;type=$_.CimClass.CimClassName}})}
})
$selected = @($items | Where-Object { $_.path -eq '\' -or (($_.name + ' ' + ($_.actions | ConvertTo-Json -Compress)) -match 'engine|mcp|codex|watch|night|smart|phpstorm|tasker|claude') })
[pscustomobject]@{total=$items.Count; selected=$selected} | ConvertTo-Json -Depth 8
