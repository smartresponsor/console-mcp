# Pure ACL classification and ancestor enumeration for immutable Windows paths.
# Caller must obtain owner/ACE evidence from the actual Windows security descriptor.
function Get-ReleaseV3ProtectedPathAncestors {
    param([Parameter(Mandatory=$true)][string]$Path)
    $full=[IO.Path]::GetFullPath($Path)
    $values=[Collections.Generic.List[string]]::new()
    $cursor=[IO.DirectoryInfo]::new($full)
    while($null -ne $cursor){
        $values.Add($cursor.FullName)
        $cursor=$cursor.Parent
    }
    if($values.Count -lt 1){throw 'RELEASE_SEAL_PATH_ANCESTORS_EMPTY'}
    return $values.ToArray()
}
function Assert-ReleaseV3AclEvidence {
    param([Parameter(Mandatory=$true)][string]$OwnerSid,
          [Parameter(Mandatory=$true)][bool]$RulesProtected,
          [Parameter(Mandatory=$true)]$AccessRules)
    if($OwnerSid -cne 'S-1-5-18' -or -not $RulesProtected){
        throw 'RELEASE_SEAL_ACL_OWNER_OR_INHERITANCE_INVALID'
    }
    # Include generic Windows write/all bits that are not always represented by
    # the FileSystemRights enum, as well as explicit DELETE_CHILD on directories.
    # Never OR composite Modify/FullControl: they include read bits and would
    # incorrectly reject legitimate ReadAndExecute-only runtime principals.
    $mutate=[long][Security.AccessControl.FileSystemRights]::Write -bor
      [long][Security.AccessControl.FileSystemRights]::Delete -bor
      [long][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [long][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [long][Security.AccessControl.FileSystemRights]::TakeOwnership -bor
      [long][Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [long][Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [long]0x40000000 -bor [long]0x10000000
    foreach($rule in @($AccessRules)){
        if([string]$rule.kind -cne 'Allow'){continue}
        if([string]$rule.sid -cnotmatch '^S-1-[0-9-]+$'){throw 'RELEASE_SEAL_ACL_SID_INVALID'}
        if([string]$rule.sid -cne 'S-1-5-18' -and
           (([long]$rule.rights -band $mutate) -ne 0)){
            throw 'RELEASE_SEAL_ACL_MUTABLE_BY_OTHER'
        }
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_ACL_EVIDENCE_VALID'
        owner_sid=$OwnerSid
        authenticated=$false
        mutation_performed=$false
    }
}
function Assert-ReleaseV3WindowsProtectedPath {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_REQUIRED'}
    $full=[IO.Path]::GetFullPath($Path)
    $directory=[IO.Path]::GetDirectoryName($full)
    # Directory ancestors must not be mutable or redirects. Volume root itself
    # may have a different OS ACL policy; start at its immediate child.
    foreach($ancestor in @(Get-ReleaseV3ProtectedPathAncestors -Path $directory)){
        if([string]::Equals($ancestor,[IO.Path]::GetPathRoot($ancestor),[StringComparison]::OrdinalIgnoreCase)){continue}
        $item=Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_ACL_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $ancestor -ErrorAction Stop
        $rules=@($acl.Access | ForEach-Object {
            @{kind=[string]$_.AccessControlType
              sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
              rights=[long]$_.FileSystemRights}
        })
        $null=Assert-ReleaseV3AclEvidence -OwnerSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -RulesProtected $acl.AreAccessRulesProtected -AccessRules $rules
    }
    $item=Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_ACL_REPARSE_POINT'}
    $acl=Get-Acl -LiteralPath $full -ErrorAction Stop
    $rules=@($acl.Access | ForEach-Object {
        @{kind=[string]$_.AccessControlType
          sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
          rights=[long]$_.FileSystemRights}
    })
    $null=Assert-ReleaseV3AclEvidence -OwnerSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -RulesProtected $acl.AreAccessRulesProtected -AccessRules $rules
    return [pscustomobject]@{status='RELEASE_SEAL_PROTECTED_PATH_VERIFIED';path=$full;mutation_performed=$false}
}
