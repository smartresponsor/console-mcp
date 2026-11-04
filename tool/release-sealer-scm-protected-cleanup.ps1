# Remove exactly the one-shot SYSTEM SCM fixture after SCM service is gone.
# Destructive only within the fixed, hash-attested Program Files test tree.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SCM_WINDOWS_REQUIRED'}
$parent='C:\Program Files\ConsoleMcp'
$child=Join-Path $parent 'SealerV3'
$file=Join-Path $child 'ConsoleMcp.Sealer.Service.exe'
$sha='ecb5ddadc2b9d0a1dec1c93089cfe0ae0f76bc44bc494cc48b0404f8f72208a1'
if(Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop){
 throw 'RELEASE_SEAL_SCM_CLEANUP_SERVICE_EXISTS'
}
if(-not (Test-Path -LiteralPath $parent -PathType Container)){
 @{status='RELEASE_SEAL_SCM_TEST_TREE_ABSENT';production_changed=$false} | ConvertTo-Json -Compress
 return
}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'RELEASE_SEAL_SCM_CLEANUP_ADMIN_REQUIRED'
}
$expected=@($parent,$child,$file)
foreach($path in $expected){
 if(-not (Test-Path -LiteralPath $path)){continue}
 $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_SCM_CLEANUP_REPARSE'}
 $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-18' -or -not $acl.AreAccessRulesProtected){
  throw 'RELEASE_SEAL_SCM_CLEANUP_ACL_DRIFT'
 }
 foreach($ace in $acl.Access){
  if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'RELEASE_SEAL_SCM_CLEANUP_ACE_UNEXPECTED'}
  $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if($sid -notin @('S-1-5-18','S-1-5-32-544')){throw 'RELEASE_SEAL_SCM_CLEANUP_ACE_UNEXPECTED'}
 }
}
if(Test-Path -LiteralPath $file){
 if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){throw 'RELEASE_SEAL_SCM_CLEANUP_BINARY_DRIFT'}
}
foreach($pair in @(@($parent,'SealerV3'),@($child,'ConsoleMcp.Sealer.Service.exe'))){
 if(Test-Path -LiteralPath $pair[0]){
  $names=@(Get-ChildItem -LiteralPath $pair[0] -Force -ErrorAction Stop | ForEach-Object {$_.Name})
  if(@($names | Where-Object {$_ -cne $pair[1]}).Count -gt 0){throw 'RELEASE_SEAL_SCM_CLEANUP_UNEXPECTED_MEMBER'}
 }
}
foreach($path in @($file,$child,$parent)){
 if(-not (Test-Path -LiteralPath $path)){continue}
 & "$env:SystemRoot\System32\takeown.exe" /F $path /A | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_CLEANUP_TAKEOWN_FAILED'}
 & "$env:SystemRoot\System32\icacls.exe" $path /grant '*S-1-5-32-544:F' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_CLEANUP_GRANT_FAILED'}
}
if(Test-Path -LiteralPath $file){[IO.File]::Delete($file)}
if(Test-Path -LiteralPath $child){[IO.Directory]::Delete($child)}
if(Test-Path -LiteralPath $parent){[IO.Directory]::Delete($parent)}
if(Test-Path -LiteralPath $parent){throw 'RELEASE_SEAL_SCM_CLEANUP_RESIDUE'}
@{status='RELEASE_SEAL_SCM_TEST_TREE_REMOVED';service_absent=$true;production_changed=$false} | ConvertTo-Json -Compress
