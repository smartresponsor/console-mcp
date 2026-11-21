# Pure replay-journal validation and transition proposal.
# The caller must independently authenticate the journal, serialize access with
# an exclusive SYSTEM-owned lock and durably persist before executing any seal.
function Assert-ReleaseV3SealReplayJournal {
    param([Parameter(Mandatory=$true)]$Journal)
    if($null -eq $Journal -or $Journal.schema_version -ne 1 -or
       $null -eq $Journal.records){throw 'RELEASE_SEAL_REPLAY_JOURNAL_INVALID'}
    $seenRequests=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $seenReleases=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $index=0
    foreach($record in @($Journal.records)){
        if($record.sequence -ne ($index+1) -or
           [string]$record.request_id -cnotmatch '^[0-9a-f]{32}$' -or
           [string]$record.release_id -cnotmatch '^[0-9a-f]{40}$' -or
           [string]$record.source_sha -cnotmatch '^[0-9a-f]{40}$' -or
           [string]$record.inventory_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
           [string]$record.phase -cnotin @('RESERVED','SEALED','FAILED')){
            throw 'RELEASE_SEAL_REPLAY_RECORD_INVALID'
        }
        if(-not $seenRequests.Add([string]$record.request_id)){throw 'RELEASE_SEAL_REPLAY_DUPLICATE_REQUEST'}
        if(-not $seenReleases.Add([string]$record.release_id)){throw 'RELEASE_SEAL_REPLAY_DUPLICATE_RELEASE'}
        $index++
    }
    return [pscustomobject]@{status='RELEASE_SEAL_REPLAY_JOURNAL_SHAPE_VALID';record_count=$index;authenticated=$false;authorization_granted=$false;mutation_performed=$false}
}
function Get-ReleaseV3SealReplayReservation {
    param([Parameter(Mandatory=$true)]$Journal,[Parameter(Mandatory=$true)]$Request)
    $null=Assert-ReleaseV3SealReplayJournal -Journal $Journal
    $null=Assert-ReleaseV3SealRequestShape -Request $Request
    if(@($Journal.records | Where-Object {$_.request_id -ceq $Request.request_id}).Count -gt 0){
        throw 'RELEASE_SEAL_REPLAY_REQUEST_CONSUMED'
    }
    if(@($Journal.records | Where-Object {$_.release_id -ceq $Request.release_id}).Count -gt 0){
        throw 'RELEASE_SEAL_REPLAY_RELEASE_CONSUMED'
    }
    $reservation=[ordered]@{
        sequence=@($Journal.records).Count+1
        request_id=[string]$Request.request_id
        release_id=[string]$Request.release_id
        source_sha=[string]$Request.source_sha
        inventory_sha256=[string]$Request.payload_inventory_sha256
        phase='RESERVED'
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_RESERVATION_PROPOSED'
        reservation=$reservation
        journal_authenticated=$false
        reservation_persisted=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
