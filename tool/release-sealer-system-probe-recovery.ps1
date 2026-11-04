# Scope-locked recovery of the *exact* isolated journal probe residue.
# No wildcard or recursive deletes, no changes outside this one test tree.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'SYSTEM_PROBE_WINDOWS_REQUIRED'}
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $workspace -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
 throw 'SYSTEM_PROBE_ISOLATED_WORKSPACE_REQUIRED'
}
$service='ConsoleMcpJournalProbeFixture'
$root='C:\Program Files\ConsoleMcpJournalProbeFixture'
$tree=Join-Path $root 'probe-root'
$authority=Join-Path $tree 'seal-authority'
$journal=Join-Path $authority 'replay-journal'
$exe=Join-Path $root 'ConsoleMcp.Sealer.SystemProbe.exe'
$receipt=Join-Path $root 'probe-pass.txt'
$sha='b30554a0537e46a6e7afd03762f57c633a4d25ff89c79dea33e665685306bd31'
$admin=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 throw 'SYSTEM_PROBE_RECOVERY_ADMIN_REQUIRED'
}
if(Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction Stop){
 throw 'SYSTEM_PROBE_RECOVERY_SERVICE_STILL_EXISTS'
}
if(-not (Test-Path -LiteralPath $root -PathType Container)){
 @{status='SYSTEM_PROBE_RECOVERY_ALREADY_ABSENT';production_changed=$false} | ConvertTo-Json -Compress; return
}
function Require-Directory([string]$dir,[string[]]$expectedNames){
 $info=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
 if(-not $info.PSIsContainer -or
   ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)){
   throw 'SYSTEM_PROBE_RECOVERY_UNEXPECTED_DIRECTORY'
 }
 $names=@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop | ForEach-Object {$_.Name})
 if(@($names | Where-Object {$_ -cnotin $expectedNames}).Count -gt 0){
  throw 'SYSTEM_PROBE_RECOVERY_UNEXPECTED_MEMBER'
 }
}
function Enable-ExactAdminAccess([string]$path){
 & (Join-Path $env:SystemRoot 'System32/takeown.exe') /F $path /A | Out-Null
 if($LASTEXITCODE -ne 0){throw ('SYSTEM_PROBE_RECOVERY_TAKEOWN_FAILED: '+$path)}
 & (Join-Path $env:SystemRoot 'System32/icacls.exe') $path /grant '*S-1-5-32-544:F' | Out-Null
 if($LASTEXITCODE -ne 0){throw ('SYSTEM_PROBE_RECOVERY_GRANT_FAILED: '+$path)}
}
Require-Directory $root @('probe-root','ConsoleMcp.Sealer.SystemProbe.exe','probe-pass.txt')
if(-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
 (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){
 throw 'SYSTEM_PROBE_RECOVERY_BINARY_UNTRUSTED'
}
# Walk top-down. Each newly accessible parent is verified BEFORE traversing
# into its fixed, single expected child; never use /R, /T, -Recurse.
Enable-ExactAdminAccess $tree
Require-Directory $tree @('seal-authority')
Enable-ExactAdminAccess $authority
Require-Directory $authority @('replay-journal')
Enable-ExactAdminAccess $journal
Require-Directory $journal @()
foreach($f in @($receipt,$exe)){
 if(Test-Path -LiteralPath $f -PathType Leaf){
  if((Get-Item -LiteralPath $f -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
   throw 'SYSTEM_PROBE_RECOVERY_FILE_REPARSE'
  }
  Enable-ExactAdminAccess $f
  [IO.File]::Delete($f)
 }
}
foreach($dir in @($journal,$authority,$tree)){
 [IO.Directory]::Delete($dir)
}
Enable-ExactAdminAccess $root
[IO.Directory]::Delete($root)
if(Test-Path -LiteralPath $root){throw 'SYSTEM_PROBE_RECOVERY_RESIDUE'}
@{status='SYSTEM_PROBE_RECOVERY_CLEAN';service_absent=$true;fixture_removed=$true;
 production_changed=$false} | ConvertTo-Json -Compress
