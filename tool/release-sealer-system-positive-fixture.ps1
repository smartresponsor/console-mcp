# One-shot isolated LocalSystem handle-chain fixture. Never touches ProgramData,
# release selectors, keys, live ConsoleMcp services or the sealer listener.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'SYSTEM_PROBE_WINDOWS_REQUIRED'}
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $workspace -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
 throw 'SYSTEM_PROBE_ISOLATED_WORKSPACE_REQUIRED'
}
$source=Join-Path $workspace 'ops/windows-sealer-system-probe/bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.SystemProbe.exe'
$sha='41847afc6d854ce7264cc747f16d4ae685f459a788533f4bb5e773dbb3e1f8f5'
if(-not (Test-Path -LiteralPath $source -PathType Leaf) -or
 (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){
 throw 'SYSTEM_PROBE_BINARY_UNTRUSTED'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
 [Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'SYSTEM_PROBE_ADMIN_REQUIRED'}
$service='ConsoleMcpJournalProbeFixture'
$root='C:\Program Files\ConsoleMcpJournalProbeFixture'
$exe=Join-Path $root 'ConsoleMcp.Sealer.SystemProbe.exe'
$tree=Join-Path $root 'probe-root'
$authority=Join-Path $tree 'seal-authority'
$journal=Join-Path $authority 'replay-journal'
$receipt=Join-Path $root 'probe-pass.txt'
$sc=Join-Path $env:SystemRoot 'System32/sc.exe'
if((Test-Path -LiteralPath $root) -or
 (Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction Stop) -or
 ((Get-Item -LiteralPath 'C:\Program Files' -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
 throw 'SYSTEM_PROBE_SCOPE_OCCUPIED'
}
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
function Protect-Directory([string]$path,[bool]$adminRead) {
 $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
 $acl.SetOwner($system)
 $acl.SetAccessRuleProtection($true,$false)
 foreach($ace in @($acl.Access)){$acl.RemoveAccessRuleAll($ace) | Out-Null}
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,
   [Security.AccessControl.FileSystemRights]::FullControl,$inherit,
   [Security.AccessControl.PropagationFlags]::None,
   [Security.AccessControl.AccessControlType]::Allow))
 if($adminRead){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admin,
   [Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,
   [Security.AccessControl.PropagationFlags]::None,
   [Security.AccessControl.AccessControlType]::Allow))
 }
 Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop
}
$created=$false
$installed=$false
$running=$false
$stopped=$false
$removed=$false
$passed=$false
$observed=@{}
$cleanupErrors=[Collections.Generic.List[string]]::new()
try {
 [IO.Directory]::CreateDirectory($journal) | Out-Null
 $created=$true
 [IO.File]::Copy($source,$exe,$false)
 # Protect the directories before registering the test service.
 foreach($dir in @($journal,$authority,$tree)){Protect-Directory $dir $false}
 Protect-Directory $root $true
 $binaryAcl=Get-Acl -LiteralPath $exe -ErrorAction Stop
 $binaryAcl.SetOwner($system)
 $binaryAcl.SetAccessRuleProtection($true,$false)
 foreach($ace in @($binaryAcl.Access)){$binaryAcl.RemoveAccessRuleAll($ace) | Out-Null}
 $binaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow))
 $binaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admin,
  [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [Security.AccessControl.AccessControlType]::Allow))
 Set-Acl -LiteralPath $exe -AclObject $binaryAcl -ErrorAction Stop
 if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){
  throw 'SYSTEM_PROBE_INSTALLED_HASH_DRIFT'
 }
 # ACL evidence is verified by the actual SYSTEM process through opened handles.
 # An interactive Administrator is intentionally unable to read SYSTEM-only
 # children after the ACL is protected; do not attempt Get-Acl here.
 & $sc create $service 'binPath=' ('"'+$exe+'"') 'type=' 'own' 'start=' 'disabled' 'obj=' 'LocalSystem' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'SYSTEM_PROBE_SCM_CREATE_FAILED'}
 $installed=$true
 & $sc config $service 'start=' 'demand' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'SYSTEM_PROBE_SCM_CONFIG_FAILED'}
 & $sc start $service | Out-Null
 if($LASTEXITCODE -ne 0){throw 'SYSTEM_PROBE_SCM_START_FAILED'}
 for($i=0;$i -lt 20;$i++){
  $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction Stop
  if($record.State -ceq 'Running'){$running=$true;break}
  Start-Sleep -Milliseconds 250
 }
 if(-not $running){throw 'SYSTEM_PROBE_NOT_RUNNING'}
 $proc=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$record.ProcessId) -ErrorAction Stop
 $sid=Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction Stop
 if([int]$proc.SessionId -ne 0 -or [string]$sid.Sid -cne 'S-1-5-18'){
  throw 'SYSTEM_PROBE_TOKEN_INVALID'
 }
 if(-not (Test-Path -LiteralPath $receipt -PathType Leaf) -or
  (Get-Content -LiteralPath $receipt -Raw -ErrorAction Stop) -cne "SYSTEM_HANDLE_CHAIN_PASS`n"){
  throw 'SYSTEM_PROBE_RECEIPT_MISSING'
 }
 $passed=$true
 $observed=@{pid=[int]$proc.ProcessId;process_sid=[string]$sid.Sid;session=[int]$proc.SessionId}
 & $sc stop $service | Out-Null
 if($LASTEXITCODE -ne 0){throw 'SYSTEM_PROBE_STOP_FAILED'}
 for($i=0;$i -lt 20;$i++){
  $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction Stop
  if($record.State -ceq 'Stopped'){$stopped=$true;break}
  Start-Sleep -Milliseconds 250
 }
 if(-not $stopped){throw 'SYSTEM_PROBE_NOT_STOPPED'}
} finally {
 if($installed){
  try {
   $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction SilentlyContinue
   if($record -and $record.State -ne 'Stopped'){
    & $sc stop $service | Out-Null
    for($i=0;$i -lt 20;$i++){
     $record=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction SilentlyContinue
     if(-not $record -or $record.State -eq 'Stopped'){break}
     Start-Sleep -Milliseconds 250
    }
   }
   & $sc delete $service | Out-Null
   if($LASTEXITCODE -ne 0){throw 'SYSTEM_PROBE_DELETE_FAILED'}
   for($i=0;$i -lt 20;$i++){
    if(-not (Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction SilentlyContinue)){
     $removed=$true;break
    }
    Start-Sleep -Milliseconds 250
   }
   if(-not $removed){throw 'SYSTEM_PROBE_SERVICE_REMOVAL_UNCONFIRMED'}
  } catch {$cleanupErrors.Add($_.Exception.Message)}
 } else {$removed=$true}
 if($created -and $removed){
  try {
   # Independent exact-path, hash-attested, nonrecursive cleanup.
   & (Join-Path $PSScriptRoot 'release-sealer-system-probe-recovery.ps1') | Out-Null
  } catch {$cleanupErrors.Add($_.Exception.Message)}
 }
 if($cleanupErrors.Count -gt 0){
  throw ('SYSTEM_PROBE_CLEANUP_INCOMPLETE: '+($cleanupErrors -join ';'))
 }
}
if(-not $passed -or -not $stopped -or -not $removed){throw 'SYSTEM_PROBE_INCOMPLETE'}
@{status='SYSTEM_JOURNAL_HANDLE_CHAIN_FIXTURE_PASS';system=$observed;binary_sha256=$sha;
 service_removed=$removed;fixture_removed=$true;production_changed=$false;
 keys_accessed=$false;seal_authorized=$false} | ConvertTo-Json -Compress
