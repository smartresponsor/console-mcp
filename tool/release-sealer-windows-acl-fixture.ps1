# Native Windows ACL probe on a uniquely marked disposable OS-temp directory.
# No Set-Acl, no privileged service, no changes to real releases or trust store.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_FIXTURE_REQUIRED'}
. (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('console-seal-acl-fixture-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($root)
$marker=Join-Path $root '.console-mcp-acl-fixture'
try {
    [IO.File]::WriteAllText($marker,'disposable windows acl fixture')
    $acl=Get-Acl -LiteralPath $root -ErrorAction Stop
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules=@($acl.Access | ForEach-Object {
        @{kind=[string]$_.AccessControlType
          sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
          rights=[long]$_.FileSystemRights}
    })
    # A normal user-owned temporary directory must NOT be admitted as sealed.
    $blocked=$false
    try {
        $null=Assert-ReleaseV3AclEvidence -OwnerSid $owner -RulesProtected $acl.AreAccessRulesProtected -AccessRules $rules
    } catch {
        $blocked=$_.Exception.Message -in @('RELEASE_SEAL_ACL_OWNER_OR_INHERITANCE_INVALID','RELEASE_SEAL_ACL_MUTABLE_BY_OTHER')
    }
    if(-not $blocked){throw 'RELEASE_SEAL_USER_TEMP_ACL_ADMITTED'}
    $pathBlocked=$false
    try {$null=Assert-ReleaseV3WindowsProtectedPath -Path $marker}
    catch {$pathBlocked=$true}
    if(-not $pathBlocked){throw 'RELEASE_SEAL_USER_TEMP_PATH_ADMITTED'}
    $ancestors=@(Get-ReleaseV3ProtectedPathAncestors -Path $root)
    if($ancestors.Count -lt 2){throw 'RELEASE_SEAL_PARENT_CHAIN_INCOMPLETE'}
    [pscustomobject]@{
        status='RELEASE_SEAL_WINDOWS_ACL_FIXTURE_PASS'
        user_temp_rejected=$true
        untrusted_chain_rejected=$true
        observed_owner_sid=$owner
        examined_ancestor_count=$ancestors.Count
        production_changed=$false
    } | ConvertTo-Json -Compress
} finally {
    if(Test-Path -LiteralPath $marker -PathType Leaf){[IO.File]::Delete($marker)}
    if(Test-Path -LiteralPath $root -PathType Container){[IO.Directory]::Delete($root)}
}
