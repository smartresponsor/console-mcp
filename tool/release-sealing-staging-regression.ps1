$ErrorActionPreference='Stop'
foreach($name in @('83-release-v3-inventory.ps1','85-release-v3-sealing.ps1','82-release-v3-source-evidence.ps1','81-release-v3-staging.ps1')){
    . (Join-Path $PSScriptRoot ('dev-console.d/'+$name))
}
$base=Join-Path ([IO.Path]::GetTempPath()) ('console-seal-stage-fixture-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $base
try {
    $source=Join-Path $base 'source'
    $parent=Join-Path $base 'destination'
    $null=New-Item -ItemType Directory -Path $source
    $null=New-Item -ItemType Directory -Path $parent
    $null=New-Item -ItemType Directory -Path (Join-Path $source 'dist')
    [IO.File]::WriteAllText((Join-Path $source 'dist/index.js'),'fixture bytes')
    $file=Join-Path $source 'dist/index.js'
    $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $inventory=@{'dist/index.js'=@{sha256=$hash;size=([IO.FileInfo]::new($file)).Length}}
    $releaseId='a'*40
    $blocked=$false
    try {$null=Invoke-ReleaseV3FixtureStage -SourceRoot $source -FixtureParent $parent -ReleaseId $releaseId -ExpectedFiles $inventory}
    catch {$blocked=$_.Exception.Message -eq 'RELEASE_STAGE_FIXTURE_REQUIRED'}
    if(-not $blocked){throw 'UNMARKED_PARENT_WAS_ACCEPTED'}
    [IO.File]::WriteAllText((Join-Path $parent '.console-mcp-sealing-fixture'),'fixture-only')
    $result=Invoke-ReleaseV3FixtureStage -SourceRoot $source -FixtureParent $parent -ReleaseId $releaseId -ExpectedFiles $inventory
    if($result.status -cne 'RELEASE_FIXTURE_STAGED_UNSEALED' -or $result.acl_sealed -or $result.production_ready -or $result.authenticated){throw 'STAGING_CLAIMED_PRODUCTION_AUTHORITY'}
    if((Get-FileHash -LiteralPath (Join-Path $result.destination 'dist/index.js') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){throw 'STAGING_BYTES_DID_NOT_MATCH'}
    $blocked=$false
    try {$null=Invoke-ReleaseV3FixtureStage -SourceRoot $source -FixtureParent $parent -ReleaseId $releaseId -ExpectedFiles $inventory}
    catch {$blocked=$_.Exception.Message -eq 'RELEASE_STAGE_DESTINATION_EXISTS'}
    if(-not $blocked){throw 'STAGE_OVERWRITE_ALLOWED'}
    [IO.File]::WriteAllText($file,'changed bytes')
    $blocked=$false
    try {$null=Invoke-ReleaseV3FixtureStage -SourceRoot $source -FixtureParent $parent -ReleaseId ('b'*40) -ExpectedFiles $inventory}
    catch {$blocked=$_.Exception.Message -in @('RELEASE_SOURCE_SIZE_DRIFT','RELEASE_SOURCE_HASH_DRIFT')}
    if(-not $blocked){throw 'SOURCE_DRIFT_NOT_REJECTED'}
    'RELEASE_FIXTURE_STAGE_REGRESSION_PASS'
} finally {
    if(Test-Path -LiteralPath $base){Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction Stop}
}
