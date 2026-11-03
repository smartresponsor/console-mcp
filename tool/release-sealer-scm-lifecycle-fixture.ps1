# Native, one-shot SYSTEM SCM smoke on a newly protected Program Files tree.
# Fail closed on existing paths/services; stop/delete service; never seal releases.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SCM_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
 throw 'RELEASE_SEAL_SCM_ISOLATED_WORKSPACE_REQUIRED'
}
$source=Join-Path $root 'ops/windows-sealer-service/bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.Service.exe'
$sha='c44a4436520bd156061762fcc6fa47c00025908aa306e2cb1d19d0228457ede9'
if(-not (Test-Path -LiteralPath $source -PathType Leaf) -or
   (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){
 throw 'RELEASE_SEAL_SCM_BINARY_UNTRUSTED'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'RELEASE_SEAL_SCM_ELEVATED_RUNNER_REQUIRED'
}
$service='ConsoleMcpReleaseSealerV3'
$parent=Join-Path $env:ProgramFiles 'ConsoleMcp'
$install=Join-Path $parent 'SealerV3'
$exe=Join-Path $install 'ConsoleMcp.Sealer.Service.exe'
if($parent -cne 'C:\Program Files\ConsoleMcp' -or
   (Test-Path -LiteralPath $parent) -or
   $null -ne (Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop)){
 throw 'RELEASE_SEAL_SCM_INSTALL_SCOPE_OCCUPIED'
}
if((Get-Item -LiteralPath $env:ProgramFiles -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
 throw 'RELEASE_SEAL_SCM_PARENT_REPARSE'
}
$createdRoot=$false
$createdService=$false
$serviceGone=$false
$stopped=$false
$running=$false
$observed=@{}
$cleanupErrors=[Collections.Generic.List[string]]::new()
function Set-FixtureSystemAcl([string]$path) {
 $acl=[Security.AccessControl.DirectorySecurity]::new()
 $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
 $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
 $acl.SetOwner($system)
 $acl.SetAccessRuleProtection($true,$false)
 $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop
}
try {
 [IO.Directory]::CreateDirectory($parent) | Out-Null
 $createdRoot=$true
 [IO.Directory]::CreateDirectory($install) | Out-Null
 [IO.File]::Copy($source,$exe,$false)
 # Do not rely on inherited file ACEs for privileged execution.
 $acl=Get-Acl -LiteralPath $install
 $fileAcl=Get-Acl -LiteralPath $exe
 $fileAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
 $fileAcl.SetAccessRuleProtection($true,$false)
 foreach($ace in @($fileAcl.Access)){$fileAcl.RemoveAccessRuleAll($ace) | Out-Null}
 $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.AccessControlType]::Allow))
 Set-Acl -LiteralPath $exe -AclObject $fileAcl -ErrorAction Stop
 Set-FixtureSystemAcl $install
 Set-FixtureSystemAcl $parent
 if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){throw 'RELEASE_SEAL_SCM_INSTALLED_HASH_DRIFT'}
 . (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
 foreach($target in @($parent,$install,$exe)){
  $security=Get-Acl -LiteralPath $target
  $rules=@($security.Access | ForEach-Object {
   @{kind=[string]$_.AccessControlType;sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;rights=[long]$_.FileSystemRights}
  })
  $null=Assert-ReleaseV3AclEvidence -OwnerSid $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -RulesProtected $security.AreAccessRulesProtected -AccessRules $rules
 }
 $sc="$env:SystemRoot\System32\sc.exe"
 & $sc create $service 'binPath=' ('"'+$exe+'"') 'type=' 'own' 'start=' 'disabled' 'obj=' 'LocalSystem' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_CREATE_FAILED'}
 $createdService=$true
 $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
 if($record.StartName -cnotin @('LocalSystem','NT AUTHORITY\SYSTEM') -or $record.StartMode -cne 'Disabled' -or $record.State -cne 'Stopped'){
  throw 'RELEASE_SEAL_SCM_INITIAL_CONFIG_DRIFT'
 }
 & $sc config $service 'start=' 'demand' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_DEMAND_CONFIG_FAILED'}
 & $sc start $service | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_START_FAILED'}
 for($i=0;$i -lt 16;$i++){
  $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
  if($record.State -ceq 'Running'){$running=$true;break}
  Start-Sleep -Milliseconds 250
 }
 if(-not $running){throw 'RELEASE_SEAL_SCM_NOT_RUNNING'}
 $process=Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId="+[int]$record.ProcessId) -ErrorAction Stop
 if($null -eq $process -or [int]$process.SessionId -ne 0){throw 'RELEASE_SEAL_SCM_PROCESS_SESSION_INVALID'}
 $ownerSid=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
 if([int]$ownerSid.ReturnValue -ne 0 -or [string]$ownerSid.Sid -cne 'S-1-5-18'){
  throw 'RELEASE_SEAL_SCM_PROCESS_OWNER_SID_INVALID'
 }
 $observed=@{state=$record.State;start_name=$record.StartName;process_id=$record.ProcessId;start_mode=$record.StartMode;
  process_session_id=[int]$process.SessionId;process_owner_sid=[string]$ownerSid.Sid}
 & $sc stop $service | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_STOP_COMMAND_FAILED'}
 for($i=0;$i -lt 20;$i++){
  $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
  if($record.State -ceq 'Stopped'){$stopped=$true;break}
  Start-Sleep -Milliseconds 250
 }
 if(-not $stopped){throw 'RELEASE_SEAL_SCM_NOT_STOPPED'}
 & $sc config $service 'start=' 'disabled' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_DISABLE_FAILED'}
} finally {
 if($createdService){
  try {
   $sc="$env:SystemRoot\System32\sc.exe"
   $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction SilentlyContinue
   if($record -and $record.State -ne 'Stopped'){
    & $sc stop $service | Out-Null
    for($i=0;$i -lt 20;$i++){
     $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction SilentlyContinue
     if(-not $record -or $record.State -eq 'Stopped'){break}
     Start-Sleep -Milliseconds 250
    }
   }
   & $sc delete $service | Out-Null
   if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_DELETE_FAILED'}
   for($i=0;$i -lt 20;$i++){
    if(-not (Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction SilentlyContinue)){$serviceGone=$true;break}
    Start-Sleep -Milliseconds 250
   }
   if(-not $serviceGone){$cleanupErrors.Add('SERVICE_REMOVAL_NOT_CONFIRMED')}
  } catch {$cleanupErrors.Add($_.Exception.Message)}
 } else {$serviceGone=$true}
 if($createdRoot -and $serviceGone){
  try {
   & (Join-Path $PSScriptRoot 'release-sealer-scm-protected-cleanup.ps1') | Out-Null
  } catch {$cleanupErrors.Add($_.Exception.Message)}
 }
 if($cleanupErrors.Count -gt 0){throw ('RELEASE_SEAL_SCM_CLEANUP_INCOMPLETE: '+($cleanupErrors -join ';'))}
}
if(-not $running -or -not $stopped -or -not $serviceGone -or (Test-Path -LiteralPath $parent)){
 throw 'RELEASE_SEAL_SCM_FIXTURE_INCOMPLETE'
}
@{status='RELEASE_SEAL_SCM_LIFECYCLE_PASS';observed=$observed;system_service_running=$running;
 stopped=$stopped;service_removed=$serviceGone;fixture_directory_removed=$true;
 sealing_authorized=$false;production_changed=$false} | ConvertTo-Json -Compress
