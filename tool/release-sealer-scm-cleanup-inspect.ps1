$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SCM_WINDOWS_REQUIRED'}
$parent=Join-Path $env:ProgramFiles 'ConsoleMcp'
$install=Join-Path $parent 'SealerV3'
$service=Get-CimInstance -Class Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
$paths=@()
foreach($path in @($parent,$install,(Join-Path $install 'ConsoleMcp.Sealer.Service.exe'))){
 $exists=Test-Path -LiteralPath $path
 $entry=@{path=$path;exists=$exists}
 if($exists){
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  $entry.owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $entry.rules_protected=$acl.AreAccessRulesProtected
  $entry.reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  $entry.children=if($item.PSIsContainer){@((Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | ForEach-Object {$_.Name}))}else{@()}
  $entry.rules=@($acl.Access | ForEach-Object {
   @{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;type=[string]$_.AccessControlType;rights=[long]$_.FileSystemRights}
  })
 }
 $paths+= $entry
}
@{status='RELEASE_SEAL_SCM_CLEANUP_READONLY';service_exists=($null -ne $service);
 service_state=if($service){$service.State}else{''};paths=$paths;production_changed=$false} | ConvertTo-Json -Depth 8 -Compress
