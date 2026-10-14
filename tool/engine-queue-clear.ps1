param([switch]$Execute, [switch]$IncludeBlocked)
$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSScriptRoot
$tasks=Join-Path $base 'var/run/engine/task'
$locks=Join-Path $base 'var/run/engine/lock'
$events=Join-Path $base 'var/log/engine/event.jsonl'
$eligible=if($IncludeBlocked){@('blocked')}else{@('queued','planned','dispatch_ready')}
$result=[ordered]@{ok=$true;execute=[bool]$Execute;eligible=0;cancelled=0;skipped=0;ids=@();errors=@()}
if(!(Test-Path $tasks)){ $result|ConvertTo-Json -Depth 5;exit 0 }
foreach($file in @(Get-ChildItem -LiteralPath $tasks -Filter '*.json' -File)){
 $handle=$null;$lockPath=Join-Path $locks ($file.BaseName+'.lock')
 try {
  $task=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
  if($eligible -notcontains [string]$task.status){continue}
  $result.eligible++
  if(!$Execute){$result.ids += [string]$task.task_id;continue}
  try{$handle=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)} catch [System.IO.IOException] {$result.skipped++;continue}
  $task=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
  if($eligible -notcontains [string]$task.status){$result.skipped++;continue}
  if([string]$task.task_id -ne $file.BaseName){throw 'Task ID mismatch'}
  $before=[string]$task.status;$stamp=[DateTime]::UtcNow.ToString('o')
  $eid='event-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
  $task.status='cancelled';$task.updated_at=$stamp;$task.next_action='Cancelled by explicit user request';$task.last_event_id=$eid
  $temp=$file.FullName+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try{
   [IO.File]::WriteAllText($temp,(($task|ConvertTo-Json -Depth 100)+"`n"),[Text.UTF8Encoding]::new($false))
   [IO.File]::Move($temp,$file.FullName,$true)
   $evt=@{event_id=$eid;ts=$stamp;task_id=$task.task_id;event='task_cancelled';source='operator';data=@{reason='explicit_user_queue_clear';before_status=$before;after_status='cancelled'}}
   [IO.File]::AppendAllText($events,(($evt|ConvertTo-Json -Compress -Depth 10)+"`n"),[Text.UTF8Encoding]::new($false))
   $result.cancelled++;$result.ids += [string]$task.task_id
  }finally{if(Test-Path $temp){Remove-Item -LiteralPath $temp -Force}}
 }catch{$result.ok=$false;$result.errors+=($file.Name+': '+$_.Exception.Message)}
 finally{if($null -ne $handle){$handle.Dispose();Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue}}
}
$result|ConvertTo-Json -Depth 5
if(!$result.ok){exit 1}
