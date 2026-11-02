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
'RELEASE_SEALING_ADMISSION_REGRESSION_PASS'

