# Fail-closed admission for immutable Windows runtime payloads.
# This does not seal or modify a release. A separately privileged deployment
# identity must provision the ACL before the broker may activate the payload.
function Assert-ReleaseV3SealedStorage {
    param([Parameter(Mandatory=$true)]$Descriptor)
    if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_REQUIRED'}
    $root=[IO.Path]::GetFullPath([string]$Descriptor.root)
    if(-not (Test-Path -LiteralPath $root -PathType Container)){throw 'RELEASE_SEAL_ROOT_MISSING'}
    # A same-user broker is not a separate write authority. Only SYSTEM may
    # retain mutation rights on sealed payloads; every other allow ACE fails.
    $writeMask=[int][Security.AccessControl.FileSystemRights]::Write -bor
        [int][Security.AccessControl.FileSystemRights]::Modify -bor
        [int][Security.AccessControl.FileSystemRights]::FullControl -bor
        [int][Security.AccessControl.FileSystemRights]::Delete -bor
        [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [int][Security.AccessControl.FileSystemRights]::TakeOwnership
    $paths=@((Split-Path -Parent $root),$root)
    # Check the actual runtime payload and directory ACLs, not just its root.
    foreach($part in @('dist','node_modules','policy','tool','config','ops','bin','prompt','package.json','package-lock.json')){
        $base=Join-Path $root $part
        if(Test-Path -LiteralPath $base){$paths+= $base}
    }
    foreach($path in $paths){
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        if(-not $acl.AreAccessRulesProtected){throw 'RELEASE_SEAL_INHERITED_ACL'}
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if($owner -cne 'S-1-5-18'){throw 'RELEASE_SEAL_OWNER_NOT_SYSTEM'}
        foreach($ace in $acl.Access){
            if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
            $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if($sid -cne 'S-1-5-18' -and (([int]$ace.FileSystemRights -band $writeMask) -ne 0)){
                throw 'RELEASE_SEAL_CALLER_CAN_WRITE'
            }
        }
    }
    # Individual members can have explicit ACLs even under a protected root.
    # Never claim the entire tree is sealed until all descriptor members are checked.
    foreach($name in @($Descriptor.files.Keys)){
        if([IO.Path]::IsPathRooted($name) -or $name -match '(^|[\\/])\.\.([\\/]|$)'){throw 'RELEASE_SEAL_UNSAFE_PATH'}
        $path=Join-Path $root $name
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        if(-not $acl.AreAccessRulesProtected){throw 'RELEASE_SEAL_INHERITED_ACL'}
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-18'){throw 'RELEASE_SEAL_OWNER_NOT_SYSTEM'}
        foreach($ace in $acl.Access){
            if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
            $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if($sid -cne 'S-1-5-18' -and (([int]$ace.FileSystemRights -band $writeMask) -ne 0)){throw 'RELEASE_SEAL_CALLER_CAN_WRITE'}
        }
    }
    return [pscustomobject]@{status='RELEASE_SEAL_ADMITTED';root=$root;checked_files=@($Descriptor.files.Keys).Count;mutation_performed=$false}
}

