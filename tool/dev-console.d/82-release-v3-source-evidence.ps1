# Read-only attestation of a candidate tree against exact inventory (name,size,sha).
# Never copies files, sets ACLs, installs services, or publishes a release.
function Get-ReleaseV3SealSourceEvidence {
    param(
        [Parameter(Mandatory=$true)][string]$SourceRoot,
        [Parameter(Mandatory=$true)]$ExpectedFiles
    )
    $root=[IO.Path]::GetFullPath($SourceRoot)
    if(-not (Test-Path -LiteralPath $root -PathType Container)){throw 'RELEASE_SOURCE_ROOT_MISSING'}
    if($null -eq $ExpectedFiles -or $ExpectedFiles.Count -lt 1){throw 'RELEASE_SOURCE_INVENTORY_EMPTY'}
    $expectedDigest=Get-ReleaseV3InventoryDigest -Files $ExpectedFiles
    $actual=@{}
    # Walk without following junctions or symbolic links. Reject *any* reparse
    # member before descending, rather than discovering links after recursion.
    $stack=[Collections.Generic.Stack[string]]::new()
    $stack.Push($root)
    while($stack.Count -gt 0){
        $directory=$stack.Pop()
        $dirItem=Get-Item -LiteralPath $directory -Force -ErrorAction Stop
        if($dirItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SOURCE_REPARSE_POINT'}
        foreach($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)){
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SOURCE_REPARSE_POINT'}
            if($item.PSIsContainer){$stack.Push($item.FullName);continue}
            $name=[IO.Path]::GetRelativePath($root,$item.FullName).Replace([IO.Path]::DirectorySeparatorChar,'/')
            $name=$name.Replace('\\','/')
            if(-not $ExpectedFiles.ContainsKey($name)){throw 'RELEASE_SOURCE_EXTRA_FILE'}
            $record=$ExpectedFiles[$name]
            if([long]$item.Length -ne [long]$record.size){throw 'RELEASE_SOURCE_SIZE_DRIFT'}
            $hash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
            if($hash -cne [string]$record.sha256){throw 'RELEASE_SOURCE_HASH_DRIFT'}
            $actual[$name]=@{sha256=$hash;size=[long]$item.Length}
        }
    }
    if($actual.Count -ne $ExpectedFiles.Count){throw 'RELEASE_SOURCE_FILE_MISSING'}
    $actualDigest=Get-ReleaseV3InventoryDigest -Files $actual
    if($actualDigest.inventory_sha256 -cne $expectedDigest.inventory_sha256){throw 'RELEASE_SOURCE_INVENTORY_DRIFT'}
    return [pscustomobject]@{
        status='RELEASE_SOURCE_BYTES_VERIFIED'
        root=$root
        inventory_sha256=$actualDigest.inventory_sha256
        verified_files=$actual.Count
        authenticated=$false
        mutation_performed=$false
    }
}

