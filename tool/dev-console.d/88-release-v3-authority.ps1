function Get-ReleaseV3Directory {
    $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Root).ToLowerInvariant()))).Substring(0,24)
    return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('ConsoleMcp/release-authority/'+$hash)
}
function Assert-ReleaseV3Broker {
    if(-not $IsWindows){throw 'WINDOWS_RELEASE_TRANSACTION_REQUIRED'}
    $broker=Get-ServerControlBrokerIdentity
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    $console=Get-ConsoleSessionReport
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if(-not $broker -or $broker.pid -ne $PID -or $session -le 0 -or
        $broker.windows_session_id -ne $session -or $broker.user_sid -cne $sid -or
        -not $console.active_console -or $console.active_console.id -ne $session){throw 'RELEASE_INTERACTIVE_BROKER_REQUIRED'}
    return $broker
}
function Get-ReleaseV3Key {
    param([switch]$ReadOnly)
    if(-not $ReadOnly){$null=Assert-ReleaseV3Broker}
    $directory=Get-ReleaseV3Directory
    if(-not (Test-Path -LiteralPath $directory)){
        if($ReadOnly){throw 'RELEASE_AUTHORITY_UNAVAILABLE'}
        $null=[IO.Directory]::CreateDirectory($directory)
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($sid)
        foreach($identity in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        }
        Set-Acl -LiteralPath $directory -AclObject $acl
    }
    # The key is outside every MCP repository root, DPAPI-bound to this user and ACL-isolated.
    $acl=Get-Acl -LiteralPath $directory
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid){throw 'RELEASE_AUTHORITY_ACL_INVALID'}
    foreach($rule in $acl.Access){
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')){throw 'RELEASE_AUTHORITY_ACL_INVALID'}
    }
    $keyPath=Join-Path $directory 'key.dpapi'
    if(-not (Test-Path -LiteralPath $keyPath)){
        if($ReadOnly){throw 'RELEASE_AUTHORITY_KEY_LOST'}
        # Missing key with existing state is key loss, never an implicit rotation.
        if(@(Get-ChildItem -LiteralPath $directory -Filter '*.json').Count){throw 'RELEASE_AUTHORITY_KEY_LOST'}
        $key=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        $protected=[Security.Cryptography.ProtectedData]::Protect($key,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        Write-ReleaseV3Atomic $keyPath $protected
    }
    return ,([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function Get-ReleaseV3Selected {
    $directory=Get-ReleaseV3Directory
    if(-not (Test-Path -LiteralPath (Join-Path $directory 'selected.json'))){return $null}
    $key=Get-ReleaseV3Key -ReadOnly
    return (Read-ReleaseV3Signed (Join-Path $directory 'selected.json') $key).release
}
function Get-ReleaseV3Descriptor {
    param([string]$Directory,[string]$Sha)
    $rootPath=[IO.Path]::GetFullPath($Directory)
    $files=[ordered]@{}
    foreach($part in @('dist','node_modules','policy','tool','config','ops','bin','package.json','package-lock.json')){
        $base=Join-Path $rootPath $part
        if(-not (Test-Path -LiteralPath $base)){continue}
        foreach($item in @(Get-Item -LiteralPath $base)+@(Get-ChildItem -LiteralPath $base -Recurse -Force -ErrorAction Stop)){
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_MEMBER_REPARSE_POINT'}
            if(-not $item.PSIsContainer){$files[[IO.Path]::GetRelativePath($rootPath,$item.FullName)]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
    }
    if(-not $files.Contains('dist'+[IO.Path]::DirectorySeparatorChar+'index.js') -or -not (Test-Path -LiteralPath (Join-Path $rootPath 'node_modules'))){throw 'RELEASE_INCOMPLETE'}
    return @{root=$rootPath;entry=(Join-Path $rootPath 'dist/index.js');sha=$Sha;files=$files}
}
function Test-ReleaseV3Descriptor {
    param($Descriptor)
    $actual=Get-ReleaseV3Descriptor $Descriptor.root $Descriptor.sha
    if($actual.entry -cne $Descriptor.entry -or $actual.files.Count -ne $Descriptor.files.Count){throw 'RELEASE_CONTENT_DRIFT'}
    foreach($name in $actual.files.Keys){if($actual.files[$name] -cne $Descriptor.files[$name]){throw 'RELEASE_CONTENT_DRIFT'}}
}
