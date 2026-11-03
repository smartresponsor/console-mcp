# Isolated fixture staging primitive. NOT a privileged sealer or production publisher.
# No ACL mutation, broker authority access, service installation or runtime control.
function Invoke-ReleaseV3FixtureStage {
    param(
        [Parameter(Mandatory=$true)][string]$SourceRoot,
        [Parameter(Mandatory=$true)][string]$FixtureParent,
        [Parameter(Mandatory=$true)][string]$ReleaseId,
        [Parameter(Mandatory=$true)]$ExpectedFiles
    )
    if($ReleaseId -cnotmatch '^[0-9a-f]{40}$'){throw 'RELEASE_STAGE_ID_INVALID'}
    $source=[IO.Path]::GetFullPath($SourceRoot)
    $parent=[IO.Path]::GetFullPath($FixtureParent)
    # This primitive is deliberately restricted to disposable fixture parents.
    if(-not (Test-Path -LiteralPath (Join-Path $parent '.console-mcp-sealing-fixture') -PathType Leaf)){
        throw 'RELEASE_STAGE_FIXTURE_REQUIRED'
    }
    $tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if(-not $parent.StartsWith($tmp.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)){
        throw 'RELEASE_STAGE_OUTSIDE_TEMP'
    }
    if($source -eq $parent -or $source.StartsWith($parent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
        throw 'RELEASE_STAGE_SOURCE_IN_DESTINATION'
    }
    $original=Get-ReleaseV3SealSourceEvidence -SourceRoot $source -ExpectedFiles $ExpectedFiles
    $destination=Join-Path $parent ('release-'+$ReleaseId)
    if(Test-Path -LiteralPath $destination){throw 'RELEASE_STAGE_DESTINATION_EXISTS'}
    $staging=Join-Path $parent ('.stage-'+[guid]::NewGuid().ToString('N'))
    $created=$false
    try {
        $null=[IO.Directory]::CreateDirectory($staging)
        $created=$true
        foreach($name in @($ExpectedFiles.Keys | Sort-Object -CaseSensitive)){
            # Recheck every source member during copy; avoid hardlinking to source.
            $relative=Assert-ReleaseV3SafeMemberPath -Root $source -Name ([string]$name)
            $target=Assert-ReleaseV3SafeMemberPath -Root $staging -Name ([string]$name)
            $parentDir=Split-Path -Parent $target
            $null=[IO.Directory]::CreateDirectory($parentDir)
            $member=Get-Item -LiteralPath $relative -Force -ErrorAction Stop
            if($member.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_STAGE_REPARSE_POINT'}
            [IO.File]::Copy($relative,$target,$false)
            $record=$ExpectedFiles[$name]
            if(([IO.FileInfo]::new($target)).Length -ne [long]$record.size){throw 'RELEASE_STAGE_SIZE_DRIFT'}
            $hash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
            if($hash -cne [string]$record.sha256){throw 'RELEASE_STAGE_HASH_DRIFT'}
        }
        $verified=Get-ReleaseV3SealSourceEvidence -SourceRoot $staging -ExpectedFiles $ExpectedFiles
        if($verified.inventory_sha256 -cne $original.inventory_sha256){throw 'RELEASE_STAGE_INVENTORY_DRIFT'}
        if(Test-Path -LiteralPath $destination){throw 'RELEASE_STAGE_DESTINATION_EXISTS'}
        [IO.Directory]::Move($staging,$destination)
        $created=$false
        return [pscustomobject]@{
            status='RELEASE_FIXTURE_STAGED_UNSEALED'
            destination=$destination
            verified_files=$verified.verified_files
            inventory_sha256=$verified.inventory_sha256
            production_ready=$false
            authenticated=$false
            acl_sealed=$false
            broker_authorized=$false
        }
    } catch {
        # Preserve failed staging for inspection. Do not silently erase evidence.
        throw
    }
}
