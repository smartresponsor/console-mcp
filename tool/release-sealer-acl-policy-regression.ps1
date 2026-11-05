$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
$system='S-1-5-18';$other='S-1-5-32-545'
$allowed=@(@{kind='Allow';sid=$system;rights=[long][Security.AccessControl.FileSystemRights]::FullControl},
 @{kind='Allow';sid=$other;rights=[long][Security.AccessControl.FileSystemRights]::ReadAndExecute})
$pass=Assert-ReleaseV3AclEvidence -OwnerSid $system -RulesProtected $true -AccessRules $allowed
if($pass.authenticated -or $pass.mutation_performed){throw 'ACL_EVIDENCE_OVERCLAIMED'}
$cases=@(
 @{name='owner';owner=$other;protected=$true;rules=$allowed},
 @{name='inherit';owner=$system;protected=$false;rules=$allowed},
 @{name='delete-child';owner=$system;protected=$true;rules=@(@{kind='Allow';sid=$other;rights=[long][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles})},
 @{name='generic-write';owner=$system;protected=$true;rules=@(@{kind='Allow';sid=$other;rights=[long]0x40000000})},
 @{name='generic-all';owner=$system;protected=$true;rules=@(@{kind='Allow';sid=$other;rights=[long]0x10000000})},
 @{name='change-owner';owner=$system;protected=$true;rules=@(@{kind='Allow';sid=$other;rights=[long][Security.AccessControl.FileSystemRights]::TakeOwnership})}
)
foreach($case in $cases){
 $blocked=$false
 try{$null=Assert-ReleaseV3AclEvidence -OwnerSid $case.owner -RulesProtected $case.protected -AccessRules $case.rules}catch{$blocked=$true}
 if(-not $blocked){throw ('ACL_UNSAFE_GRANTED: '+$case.name)}
}
$ancestors=@(Get-ReleaseV3ProtectedPathAncestors -Path (Join-Path ([IO.Path]::GetTempPath()) 'aaa/bbb'))
if($ancestors.Count -lt 2){throw 'ACL_PARENT_CHAIN_MISSING'}
if(-not $IsWindows){
 $blocked=$false
 try{$null=Assert-ReleaseV3WindowsProtectedPath -Path (Join-Path ([IO.Path]::GetTempPath()) 'aaa/bbb')}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_WINDOWS_REQUIRED'}
 if(-not $blocked){throw 'NONWINDOWS_ACL_ADMITTED'}
}
'RELEASE_SEALER_ACL_POLICY_REGRESSION_PASS'
