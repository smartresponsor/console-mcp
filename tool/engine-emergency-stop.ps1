param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.Name -match '^(node|pwsh|powershell)(\.exe)?$' -and
  $_.CommandLine -and $_.CommandLine -match 'engine-cli\.js|engine-cycle-rounds' -and $_.CommandLine -match 'console-mcp'
})
$tasks = @(Get-ScheduledTask | Where-Object {
  @($_.Actions | Where-Object { $_.Arguments -match 'engine-cli|engine:(loop|tick)|engine\s+(loop|tick|bank-run|bank-step|go|cycle-run)|engine-cycle-rounds' }).Count -gt 0
})
$report = [ordered]@{execute=[bool]$Execute;processes=@($processes | ForEach-Object {@{pid=$_.ProcessId;commandLine=$_.CommandLine}});scheduledTasks=@($tasks | ForEach-Object {@{name=$_.TaskName;path=$_.TaskPath;state=[string]$_.State}});stoppedProcesses=@();disabledTasks=@();errors=@()}
if ($Execute) {
 foreach ($task in $tasks) {
  try { Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop | Out-Null; if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop }; $report.disabledTasks += "$($task.TaskPath)$($task.TaskName)" }
  catch { $report.errors += "task $($task.TaskName): $($_.Exception.Message)" }
 }
 foreach ($proc in $processes) {
  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; $report.stoppedProcesses += $proc.ProcessId }
  catch { $report.errors += "process $($proc.ProcessId): $($_.Exception.Message)" }
 }
}
$report | ConvertTo-Json -Depth 6
if ($report.errors.Count) { exit 1 }
