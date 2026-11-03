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
. (Join-Path $PSScriptRoot 'dev-console.d/83-release-v3-inventory.ps1')
$h1=('a'*64);$h2=('b'*64)
$inventoryA=@{ 'dist/index.js'=@{sha256=$h1;size=12};'package.json'=@{sha256=$h2;size=200}}
$inventoryB=[ordered]@{'package.json'=@{size=200;sha256=$h2};'dist/index.js'=@{size=12;sha256=$h1}}
$d1=Get-ReleaseV3InventoryDigest -Files $inventoryA
$d2=Get-ReleaseV3InventoryDigest -Files $inventoryB
if($d1.inventory_sha256 -cne $d2.inventory_sha256 -or $d1.file_count -ne 2 -or $d1.authenticated){throw 'INVENTORY_DIGEST_NON_DETERMINISTIC'}
$inventoryB['package.json']=@{size=201;sha256=$h2}
$d3=Get-ReleaseV3InventoryDigest -Files $inventoryB
if($d3.inventory_sha256 -ceq $d1.inventory_sha256){throw 'INVENTORY_SIZE_NOT_BOUND'}
foreach($badName in @('../secret','a/../secret','C:evil','a\\file','/absolute','two//slashes',('bad'+[char]10+'name'))){
 $refused=$false
 try{$null=Get-ReleaseV3InventoryDigest -Files @{$badName=@{sha256=$h1;size=1}}}catch{$refused=$true}
 if(-not $refused){throw ('INVENTORY_UNSAFE_PATH_ACCEPTED: '+$badName)}
}
foreach($badEntry in @(@{sha256='INVALID';size=1},@{sha256=$h1;size=-1},@{sha256=$h1;size='01'})){
 $refused=$false
 try{$null=Get-ReleaseV3InventoryDigest -Files @{'valid.txt'=$badEntry}}catch{$refused=$true}
 if(-not $refused){throw 'INVENTORY_BAD_ENTRY_ACCEPTED'}
}
. (Join-Path $PSScriptRoot 'dev-console.d/82-release-v3-source-evidence.ps1')
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('release-v3-source-evidence-'+[guid]::NewGuid().ToString('N'))
try {
 $null=New-Item -ItemType Directory -Path $fixture -ErrorAction Stop
 $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'dist') -ErrorAction Stop
 $path=Join-Path $fixture 'dist/index.js'
 [IO.File]::WriteAllText($path,'original source')
 $file=[IO.FileInfo]::new($path)
 $sha=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
 $expected=@{'dist/index.js'=@{sha256=$sha;size=$file.Length}}
 $attested=Get-ReleaseV3SealSourceEvidence -SourceRoot $fixture -ExpectedFiles $expected
 if($attested.status -cne 'RELEASE_SOURCE_BYTES_VERIFIED' -or $attested.verified_files -ne 1 -or $attested.mutation_performed){throw 'SOURCE_ATTESTATION_INVALID'}
 [IO.File]::WriteAllText($path,'modified source')
 $blocked=$false
 try{$null=Get-ReleaseV3SealSourceEvidence -SourceRoot $fixture -ExpectedFiles $expected}catch{$blocked=$true}
 if(-not $blocked){throw 'SOURCE_MUTATION_NOT_DETECTED'}
 [IO.File]::WriteAllText($path,'original source')
 [IO.File]::WriteAllText((Join-Path $fixture 'extra.txt'),'extra')
 $blocked=$false
 try{$null=Get-ReleaseV3SealSourceEvidence -SourceRoot $fixture -ExpectedFiles $expected}catch{$blocked=$true}
 if(-not $blocked){throw 'SOURCE_EXTRA_FILE_NOT_DETECTED'}
 Remove-Item -LiteralPath (Join-Path $fixture 'extra.txt') -Force
 $expected['dist/index.js'].size=0
 $blocked=$false
 try{$null=Get-ReleaseV3SealSourceEvidence -SourceRoot $fixture -ExpectedFiles $expected}catch{$blocked=$true}
 if(-not $blocked){throw 'SOURCE_SIZE_DRIFT_NOT_DETECTED'}
} finally {
 if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction Stop}
}
'RELEASE_SEALING_ADMISSION_REGRESSION_PASS'

