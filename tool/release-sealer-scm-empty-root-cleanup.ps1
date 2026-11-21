# One-time cleanup of a known empty test root, never production.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SCM_WINDOWS_REQUIRED'}
$parent='C:\Program Files\ConsoleMcp'
$install=Join-Path $parent 'SealerV3'
if($null -ne (Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop)){
 throw 'RELEASE_SEAL_SCM_SERVICE_STILL_PRESENT'
}
if(-not (Test-Path -LiteralPath $parent -PathType Container)){
 @{status='RELEASE_SEAL_SCM_FIXTURE_ALREADY_CLEAN';production_changed=$false} | ConvertTo-Json -Compress
 return
}
$dir=Get-Item -LiteralPath $parent -Force
if($dir.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_SCM_UNSAFE_REPARSE'}
$children=@(Get-ChildItem -LiteralPath $parent -Force)
if($children.Count -ne 0 -or (Test-Path -LiteralPath $install)){throw 'RELEASE_SEAL_SCM_ROOT_NOT_EMPTY'}
$acl=Get-Acl -LiteralPath $parent
if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-18' -or -not $acl.AreAccessRulesProtected){
 throw 'RELEASE_SEAL_SCM_ROOT_NOT_FIXTURE_PROTECTED'
}
$observed=@($acl.Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})
if(@($observed | Where-Object {$_ -notin @('S-1-5-18','S-1-5-32-544')}).Count -gt 0){
 throw 'RELEASE_SEAL_SCM_ROOT_UNEXPECTED_ACE'
}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'RELEASE_SEAL_SCM_ELEVATION_REQUIRED'
}
& "$env:SystemRoot\System32\takeown.exe" /F $parent /A | Out-Null
if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_TAKEOWN_FAILED'}
& "$env:SystemRoot\System32\icacls.exe" $parent /grant '*S-1-5-32-544:F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SCM_CLEANUP_ACL_FAILED'}
[IO.Directory]::Delete($parent)
if(Test-Path -LiteralPath $parent){throw 'RELEASE_SEAL_SCM_ROOT_REMAINS'}
@{status='RELEASE_SEAL_SCM_EMPTY_ROOT_REMOVED';service_exists=$false;production_changed=$false} | ConvertTo-Json -Compress
