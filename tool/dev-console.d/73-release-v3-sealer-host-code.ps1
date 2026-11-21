# Read-only protected-code admission for a separately provisioned SYSTEM sealer.
# Never execute arbitrary scripts from an interactive checkout in a SYSTEM host.
function Assert-ReleaseV3SealerHostCode {
    param([Parameter(Mandatory=$true)][string]$CodeRoot,
          [Parameter(Mandatory=$true)]$ExpectedFiles)
    if(-not $IsWindows){throw 'RELEASE_SEAL_HOST_CODE_WINDOWS_REQUIRED'}
    if($null -eq $ExpectedFiles -or $ExpectedFiles.Count -lt 1){throw 'RELEASE_SEAL_HOST_CODE_MANIFEST_REQUIRED'}
    $root=[IO.Path]::GetFullPath($CodeRoot)
    if(-not (Test-Path -LiteralPath $root -PathType Container)){
        throw 'RELEASE_SEAL_HOST_CODE_ROOT_MISSING'
    }
    $null=Assert-ReleaseV3WindowsProtectedPath -Path $root
    $actual=@{}
    $stack=[Collections.Generic.Stack[string]]::new()
    $stack.Push($root)
    while($stack.Count -gt 0){
        $current=$stack.Pop()
        foreach($item in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)){
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
                throw 'RELEASE_SEAL_HOST_CODE_REPARSE'
            }
            if($item.PSIsContainer){$stack.Push($item.FullName);continue}
            $name=[IO.Path]::GetRelativePath($root,$item.FullName).Replace([char]92,'/')
            if($actual.ContainsKey($name)){throw 'RELEASE_SEAL_HOST_CODE_DUPLICATE'}
            if(-not $ExpectedFiles.ContainsKey($name)){
                throw 'RELEASE_SEAL_HOST_CODE_EXTRA_FILE'
            }
            $expectedHash=[string]$ExpectedFiles[$name]
            if($expectedHash -cnotmatch '^[0-9a-f]{64}$'){
                throw 'RELEASE_SEAL_HOST_CODE_HASH_INVALID'
            }
            $null=Assert-ReleaseV3WindowsProtectedPath -Path $item.FullName
            $hash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
            if($hash -cne $expectedHash){throw 'RELEASE_SEAL_HOST_CODE_HASH_DRIFT'}
            $actual[$name]=$true
        }
    }
    if($actual.Count -ne $ExpectedFiles.Count){throw 'RELEASE_SEAL_HOST_CODE_MISSING_FILE'}
    foreach($name in @($ExpectedFiles.Keys)){
        if($name -cnotmatch '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$' -or
           -not $actual.ContainsKey([string]$name)){
            throw 'RELEASE_SEAL_HOST_CODE_MANIFEST_INVALID'
        }
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_HOST_CODE_ATTESTED'
        file_count=$actual.Count
        token_authenticated=$false
        private_key_verified=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
