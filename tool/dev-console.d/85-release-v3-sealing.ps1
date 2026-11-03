# Fail-closed admission for immutable Windows runtime payloads.
# This does not seal or modify a release. A separately privileged deployment
# identity must provision the ACL before the broker may activate the payload.
function Assert-ReleaseV3SafeMemberPath {
    param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$Name)
    if([string]::IsNullOrWhiteSpace($Name) -or [IO.Path]::IsPathRooted($Name) -or
        $Name -match '(^|[\\/])\.{1,2}([\\/]|$)' -or $Name.Contains(':') -or
        $Name.StartsWith('\\') -or $Name.StartsWith('/')){throw 'RELEASE_SEAL_UNSAFE_PATH'}
    $base=[IO.Path]::GetFullPath($Root)
    $resolved=[IO.Path]::GetFullPath((Join-Path $base $Name))
    if(-not $resolved.StartsWith($base.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
        throw 'RELEASE_SEAL_UNSAFE_PATH'
    }
    return $resolved
}
function Assert-ReleaseV3SealedStorage {
    param([Parameter(Mandatory=$true)]$Descriptor)
    if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_REQUIRED'}
    $root=[IO.Path]::GetFullPath([string]$Descriptor.root)
    if(-not (Test-Path -LiteralPath $root -PathType Container)){throw 'RELEASE_SEAL_ROOT_MISSING'}
    # A same-user broker is not a separate write authority. Only SYSTEM may
    # retain mutation rights on sealed payloads; every other allow ACE fails.
    $writeMask=[long][Security.AccessControl.FileSystemRights]::Write -bor
        [int][Security.AccessControl.FileSystemRights]::Delete -bor
        [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [int][Security.AccessControl.FileSystemRights]::TakeOwnership -bor
        [int][Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [int][Security.AccessControl.FileSystemRights]::WriteExtendedAttributes
    $null=Assert-ReleaseV3WindowsProtectedPath -Path $root
    $paths=@((Split-Path -Parent $root),$root)
    # Validate every intermediate directory and member, not only top-level parts.
    $paths+=@(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop | ForEach-Object {$_.FullName})
    # Check the actual runtime payload and directory ACLs, not just its root.
    foreach($part in @('dist','node_modules','policy','tool','config','ops','bin','prompt','package.json','package-lock.json')){
        $base=Join-Path $root $part
        if(Test-Path -LiteralPath $base){$paths+= $base}
    }
    $paths=@($paths | Select-Object -Unique)
    foreach($path in $paths){
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        $aclEvidence=@($acl.Access | ForEach-Object {
            @{kind=[string]$_.AccessControlType
              sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
              rights=[long]$_.FileSystemRights}
        })
        $null=Assert-ReleaseV3AclEvidence -OwnerSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -RulesProtected $acl.AreAccessRulesProtected -AccessRules $aclEvidence
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
    # Verify that the complete file inventory is exactly the signed descriptor.
    $expected=@{}
    foreach($name in @($Descriptor.files.Keys)){
        if([string]::IsNullOrWhiteSpace([string]$name) -or [IO.Path]::IsPathRooted($name) -or $name -match '(^|[\\/])\.{1,2}([\\/]|$)' -or $name.Contains(':')){throw 'RELEASE_SEAL_UNSAFE_PATH'}
        $safe=Assert-ReleaseV3SafeMemberPath -Root $root -Name ([string]$name)
        if($expected.ContainsKey($safe)){throw 'RELEASE_SEAL_DUPLICATE_MEMBER'}
        $expected[$safe]=$true
    }
    $actual=@{}
    foreach($path in $paths){
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if(-not $item.PSIsContainer -and $item.FullName.StartsWith($root.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
            if(-not $expected.ContainsKey($item.FullName)){throw 'RELEASE_SEAL_EXTRA_FILE'}
            $actual[$item.FullName]=$true
        }
    }
    if($actual.Count -ne $expected.Count){throw 'RELEASE_SEAL_MEMBER_MISSING'}
    # Individual members can have explicit ACLs even under a protected root.
    # Never claim the entire tree is sealed until all descriptor members are checked.
    foreach($name in @($Descriptor.files.Keys)){
        if([IO.Path]::IsPathRooted($name) -or $name -match '(^|[\\/])\.\.([\\/]|$)'){throw 'RELEASE_SEAL_UNSAFE_PATH'}
        $path=Join-Path $root $name
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        $aclEvidence=@($acl.Access | ForEach-Object {
            @{kind=[string]$_.AccessControlType
              sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
              rights=[long]$_.FileSystemRights}
        })
        $null=Assert-ReleaseV3AclEvidence -OwnerSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -RulesProtected $acl.AreAccessRulesProtected -AccessRules $aclEvidence
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

