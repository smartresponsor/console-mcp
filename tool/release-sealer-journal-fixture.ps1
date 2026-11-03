# Disposable authenticated replay-journal fixture. NOT a production SYSTEM authority.
# Reuses schema-3 atomic signed state and exclusive OS file lock; only within
# an explicitly marked isolated directory under the OS temp root.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$FixtureDirectory,
      [ValidateSet('initialize','reserve','inspect')][string]$Operation='inspect',
      [string]$RequestJson='', [string]$KeyHex='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/79-release-v3-sealer-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1')

$directory=[IO.Path]::GetFullPath($FixtureDirectory)
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
if(-not $directory.StartsWith($temp,[StringComparison]::Ordinal) -or
   -not (Test-Path -LiteralPath $directory -PathType Container) -or
   -not (Test-Path -LiteralPath (Join-Path $directory '.console-mcp-sealer-journal-fixture') -PathType Leaf)){
    throw 'SEAL_JOURNAL_FIXTURE_SCOPE_REQUIRED'
}
$cursor=[IO.DirectoryInfo]::new($directory)
while($null -ne $cursor){
    if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SEAL_JOURNAL_REPARSE_POINT'}
    $cursor=$cursor.Parent
}
if($KeyHex -cnotmatch '^[0-9a-f]{64}$'){throw 'SEAL_JOURNAL_FIXTURE_KEY_REQUIRED'}
$key=[Convert]::FromHexString($KeyHex)
$path=Join-Path $directory 'sealer-replay.json'
$lock=Open-ReleaseV3Lock $directory
try {
    if($Operation -eq 'initialize'){
        if(Test-Path -LiteralPath $path){throw 'SEAL_JOURNAL_ALREADY_INITIALIZED'}
        $items=@(Get-ChildItem -LiteralPath $directory -Force -File |
            Where-Object {$_.Name -match '^sealer-replay\\.json' -or $_.Name -match '^sealer-replay\\.json\\.'})
        if($items.Count){throw 'SEAL_JOURNAL_AMBIGUOUS_STATE'}
        $journal=@{schema_version=1;records=@()}
        Write-ReleaseV3Signed $path $journal $key
        $verified=Read-ReleaseV3Signed $path $key
        $null=Assert-ReleaseV3SealReplayJournal -Journal $verified
        @{status='SEAL_JOURNAL_FIXTURE_INITIALIZED';records=0;production_authority=$false} | ConvertTo-Json -Compress
        return
    }
    if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'SEAL_JOURNAL_NOT_INITIALIZED'}
    $journal=Read-ReleaseV3Signed $path $key
    $null=Assert-ReleaseV3SealReplayJournal -Journal $journal
    if($Operation -eq 'inspect'){
        @{status='SEAL_JOURNAL_FIXTURE_AUTHENTICATED';records=@($journal.records).Count;production_authority=$false} | ConvertTo-Json -Compress
        return
    }
    if([string]::IsNullOrWhiteSpace($RequestJson)){throw 'SEAL_JOURNAL_REQUEST_REQUIRED'}
    $request=$RequestJson | ConvertFrom-Json -AsHashtable -DateKind String
    $proof=Assert-ReleaseV3SealerAuthenticatedRequest -Request $request -Key $key -ServiceIdentity 'S-1-5-18'
    # This only simulates a SYSTEM-identity fixture. Never treat proof as a real
    # process token or privilege boundary.
    $proposal=Get-ReleaseV3SealReplayReservation -Journal $journal -Request $request
    $journal.records=@($journal.records)+@($proposal.reservation)
    Write-ReleaseV3Signed $path $journal $key
    $confirmed=Read-ReleaseV3Signed $path $key
    $null=Assert-ReleaseV3SealReplayJournal -Journal $confirmed
    if(@($confirmed.records).Count -ne @($journal.records).Count){throw 'SEAL_JOURNAL_RESERVATION_VERIFY_FAILED'}
    @{status='SEAL_JOURNAL_FIXTURE_RESERVED';request_id=$request.request_id;
      records=@($confirmed.records).Count;reservation_persisted=$true;
      production_authority=$false;privileged_work_performed=$false} | ConvertTo-Json -Compress
} finally {
    $lock.Dispose()
}
