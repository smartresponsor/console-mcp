# Supported broker-only handoff. Existing Node/browser processes are never explicitly stopped.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ControlRoot,[switch]$Restore,[ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$CheckpointName='initial')
$ErrorActionPreference='Stop'
if(-not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Managed interactive session required'}
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
$codeCommon=(& git -C (Split-Path -Parent $PSScriptRoot) rev-parse --path-format=absolute --git-common-dir | Out-String).Trim()
if($LASTEXITCODE -ne 0){throw 'Broker code is not a Git checkout'}
$controlCommon=(& git -C $ControlRoot rev-parse --path-format=absolute --git-common-dir | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $codeCommon -ine $controlCommon){throw 'Broker/control repository mismatch'}
$codeRoot=Split-Path -Parent $PSScriptRoot
if((& git -C $codeRoot rev-parse HEAD).Trim() -cne (& git -C $codeRoot rev-parse origin/master).Trim() -or
    (& git -C $codeRoot status --porcelain | Out-String).Trim()){throw 'Broker upgrade requires clean canonical master code'}
$run=Join-Path $ControlRoot 'var/run';$bootstrap=Join-Path $run 'watchdog-task-bootstrap.ps1'
$recoveryRoot=Join-Path $run 'broker-upgrade-recovery'
$null=[IO.Directory]::CreateDirectory($recoveryRoot)
$lock=Open-ReleaseV3Lock $recoveryRoot
$recovery=if($CheckpointName -eq 'initial'){$recoveryRoot}else{Join-Path $recoveryRoot $CheckpointName}
$null=[IO.Directory]::CreateDirectory($recovery)
$checkpoint=Join-Path $recovery 'checkpoint.json'
$privateDirectory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ConsoleMcp/broker-checkpoints'
if(-not (Test-Path -LiteralPath $privateDirectory)){
 $null=[IO.Directory]::CreateDirectory($privateDirectory)
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($sid)
 foreach($who in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 Set-Acl -LiteralPath $privateDirectory -AclObject $acl
}
$acl=Get-Acl -LiteralPath $privateDirectory
if(-not $acl.AreAccessRulesProtected){throw 'Broker checkpoint authority ACL invalid'}
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($ControlRoot).ToLowerInvariant())))
$suffix=if($CheckpointName -eq 'initial'){''}else{'-'+$CheckpointName}
$privateRecord=Join-Path $privateDirectory ($hash+$suffix+'.dpapi')
function Start-PinnedTask {
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect()
 $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
 $null=$scheduler.GetFolder('\').GetTask('console-mcp-watchdog').RunEx($null,4,$session,$null)
}
function Restore-PinnedBroker($record){
 if((Get-FileHash -LiteralPath $record.bootstrap -Algorithm SHA256).Hash -cne $record.bootstrapHash -or
    (Get-FileHash -LiteralPath $record.task -Algorithm SHA256).Hash -cne $record.taskHash){throw 'Broker rollback checkpoint tampered'}
 Stop-ScheduledTask -TaskName console-mcp-watchdog -ErrorAction SilentlyContinue
 Write-ReleaseV3Atomic $bootstrap ([IO.File]::ReadAllBytes($record.bootstrap))
 $null=Register-ScheduledTask -TaskName console-mcp-watchdog -Xml ([IO.File]::ReadAllText($record.task)) -Force
 Start-PinnedTask
}
try {
 $node=Get-NetTCPConnection -State Listen -LocalPort 3333 -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess
 $identity=Get-Process -Id $node
 $nodeStarted=$identity.StartTime.ToUniversalTime().ToString('o')
 if($Restore){
  if(-not (Test-Path -LiteralPath $privateRecord)){throw 'No authenticated broker checkpoint'}
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($privateRecord),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $record=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -DateKind String
  Restore-PinnedBroker $record
  @{ok=$true;status='BROKER_CHECKPOINT_RESTORED';nodePid=$node;runtimeReplacementRequested=$false} | ConvertTo-Json
  exit
 }
 if(Test-Path -LiteralPath $checkpoint){throw 'Existing broker checkpoint requires review; never overwrite it'}
 $old=Get-Content -Raw (Join-Path $run 'server-control/broker.json') | ConvertFrom-Json
 if($old.windows_session_id -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'Broker session mismatch'}
 $taskPath=Join-Path $recovery 'original-task.xml';$bootstrapPath=Join-Path $recovery 'original-bootstrap.ps1'
 Export-ScheduledTask -TaskName console-mcp-watchdog | Set-Content -LiteralPath $taskPath
 [IO.File]::Copy($bootstrap,$bootstrapPath,$false)
 $record=@{task=$taskPath;bootstrap=$bootstrapPath;previousBrokerPid=$old.pid;nodePid=$node;nodeStarted=$nodeStarted;codeRoot=(Split-Path -Parent $PSScriptRoot)}
 $record.bootstrapHash=(Get-FileHash -LiteralPath $bootstrapPath -Algorithm SHA256).Hash
 $record.taskHash=(Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash
 if(Test-Path -LiteralPath $privateRecord){throw 'Private broker checkpoint already exists; explicit review required'}
 $protected=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 Write-ReleaseV3Atomic $privateRecord $protected
 Write-ReleaseV3Atomic $checkpoint ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress)))
 try {
  $null=& (Join-Path $PSScriptRoot 'dev-console.ps1') -ControlRoot $ControlRoot install-watchdog-task
  $null=& (Join-Path $PSScriptRoot 'dev-console.ps1') -ControlRoot $ControlRoot start-watchdog-loop --scheduled
  $deadline=[datetime]::UtcNow.AddSeconds(30);$ready=$false
  do{
   $broker=Get-Content -Raw (Join-Path $run 'server-control/broker.json') | ConvertFrom-Json
   if($broker.pid -ne $old.pid -and $broker.supported_actions -contains 'release-v3' -and
       $broker.windows_session_id -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and
       ([datetime]::UtcNow-([datetime]$broker.heartbeat_at).ToUniversalTime()).TotalSeconds -lt 5){$ready=$true;break}
   Start-Sleep -Milliseconds 200
  }while([datetime]::UtcNow -lt $deadline)
  if(-not $ready){throw 'New release broker did not become ready'}
  $current=Get-NetTCPConnection -State Listen -LocalPort 3333 -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess
  if($current -ne $node -or (Get-Process -Id $node).StartTime.ToUniversalTime().ToString('o') -cne $nodeStarted){throw 'Broker upgrade changed the production runtime'}
  @{ok=$true;status='RELEASE_BROKER_UPGRADED_OBSERVE_ONLY';brokerPid=$broker.pid;session=$broker.windows_session_id;nodePid=$node;checkpoint=$checkpoint;runtimeReplacementRequested=$false} | ConvertTo-Json
 }catch{
  Restore-PinnedBroker $record
  throw 'Broker upgrade failed; original task/bootstrap restored. Authenticate and verify runtime before retrying.'
 }
} finally {$lock.Dispose()}
