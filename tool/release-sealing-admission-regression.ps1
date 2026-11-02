# Static and non-Windows fail-closed regression; does not change ACLs or runtime.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$module=Join-Path $PSScriptRoot 'dev-console.d/85-release-v3-sealing.ps1'
$control=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1') -Raw
$tokens=$null;$errors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($module,[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'SEALING_MODULE_PARSE_FAILED'}
if($control -notmatch 'Assert-ReleaseV3SealedStorage -Descriptor \$State\.candidate' -or
   $control -notmatch 'Assert-ReleaseV3SealedStorage -Descriptor \$State\.previous'){throw 'SEALING_ACTIVATION_GATE_MISSING'}
if($control.IndexOf('Assert-ReleaseV3SealedStorage -Descriptor $State.candidate') -gt
   $control.IndexOf('Get-InteractiveDesktopCapabilityLease')){throw 'SEALING_GATE_ORDER_INVALID'}
$content=Get-Content -LiteralPath $module -Raw
foreach($required in @('RELEASE_SEAL_INHERITED_ACL','RELEASE_SEAL_OWNER_NOT_SYSTEM','RELEASE_SEAL_CALLER_CAN_WRITE','RELEASE_SEAL_REPARSE_POINT','RELEASE_SEAL_UNSAFE_PATH')){
    if(-not $content.Contains($required)){throw ('SEALING_FAIL_CLOSED_CASE_MISSING: '+$required)}
}
if($content -match '(?i)\bSet-Acl\b|\bicacls\b|\btakeown\b|\bSet-ItemProperty\b|\bSet-Content\b|\bWriteAllBytes\b'){throw 'SEALING_ADMISSION_MUTATION_FORBIDDEN'}
. $module
$good=Assert-ReleaseV3SafeMemberPath -Root ([IO.Path]::GetTempPath()) -Name 'dist/index.js'
if(-not $good.EndsWith('index.js')){throw 'SAFE_MEMBER_REJECTED'}
foreach($unsafe in @('','../index.js','a/../../index.js','./index.js','a/./index.js','C:\\Windows\\system.ini','/etc/passwd','\\\\server\\share','a:b')){
    $refused=$false
    try{$null=Assert-ReleaseV3SafeMemberPath -Root ([IO.Path]::GetTempPath()) -Name $unsafe}catch{$refused=$_.Exception.Message -eq 'RELEASE_SEAL_UNSAFE_PATH'}
    if(-not $refused){throw ('UNSAFE_MEMBER_ACCEPTED: '+$unsafe)}
}
if(-not $IsWindows){
    $blocked=$false
    try{$null=Assert-ReleaseV3SealedStorage -Descriptor @{root='/tmp';files=@{}}}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_WINDOWS_REQUIRED'}
    if(-not $blocked){throw 'NON_WINDOWS_SEALING_MUST_FAIL_CLOSED'}
}
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
$now=[datetimeoffset]::UtcNow
$sample=@{
 schema_version=1;operation='seal_new_release'
 request_id=('a'*32);source_sha=('b'*40);payload_inventory_sha256=('c'*64)
 release_id=('d'*40);rollback_release_id=('e'*40)
 expires_at=$now.AddMinutes(5).ToString('o');authority_mac=('f'*64)
}
$valid=Assert-ReleaseV3SealRequestShape -Request $sample -Now $now
if($valid.status -cne 'RELEASE_SEAL_REQUEST_SHAPE_VALID' -or $valid.authenticated -or $valid.authorization_granted){throw 'SEAL_REQUEST_SHAPE_AUTHORITY_CONFUSION'}
foreach($case in @('expired','extra','self-rollback','bad-mac','bad-sha')){
 $bad=$sample.Clone()
 switch($case){
  'expired' {$bad.expires_at=$now.AddMinutes(-1).ToString('o')}
  'extra' {$bad['untrusted_field']='unauthorized'}
  'self-rollback' {$bad.rollback_release_id=$bad.release_id}
  'bad-mac' {$bad.authority_mac='not-a-mac'}
  'bad-sha' {$bad.source_sha='HEAD'}
 }
 $blocked=$false
 try{$null=Assert-ReleaseV3SealRequestShape -Request $bad -Now $now}catch{$blocked=$true}
 if(-not $blocked){throw ('SEAL_REQUEST_CASE_ACCEPTED: '+$case)}
}
'RELEASE_SEALING_ADMISSION_REGRESSION_PASS'

