# Read-only journal schema gate. This does not grant commit authority.
function Test-RuntimeReleaseJournalSchema {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)]$Journal)
    $fields = @('schema_version','transaction_id','status','candidate_entrypoint',
        'candidate_sha','candidate_sha256','expected_broker_generation',
        'expected_login_epoch','created_at','commit_enabled','runtime_mutated')
    foreach ($field in $fields) {
        if ($null -eq $Journal.PSObject.Properties[$field]) { return $false }
        if ($null -eq $Journal.$field) { return $false }
    }
    if ($Journal.schema_version -isnot [int] -and $Journal.schema_version -isnot [long]) { return $false }
    if ([long]$Journal.schema_version -notin @(1,2)) { return $false }
    if ([string]$Journal.transaction_id -cnotmatch '^[0-9a-f]{32}$') { return $false }
    if ([string]$Journal.status -cne 'PREPARED') { return $false }
    if ([string]$Journal.candidate_sha -cnotmatch '^[0-9a-f]{40}$') { return $false }
    if ([string]$Journal.candidate_sha256 -cnotmatch '^[0-9a-f]{64}$') { return $false }
    foreach ($field in @('candidate_entrypoint','expected_broker_generation','expected_login_epoch')) {
        if ([string]::IsNullOrWhiteSpace([string]$Journal.$field)) { return $false }
    }
    $created = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Journal.created_at, [ref]$created)) { return $false }
    if ($Journal.commit_enabled -isnot [bool] -or $Journal.commit_enabled) { return $false }
    if ($Journal.runtime_mutated -isnot [bool] -or $Journal.runtime_mutated) { return $false }
    # Optional v1 incumbent must be structurally valid when present; no live process lookup here.
    if ($null -ne $Journal.PSObject.Properties['incumbent'] -and $null -ne $Journal.incumbent) {
        $snapshot = $Journal.incumbent
        if ($null -eq $snapshot.PSObject.Properties['pid'] -or
            $null -eq $snapshot.PSObject.Properties['started_at'] -or
            $null -eq $snapshot.PSObject.Properties['captured_at']) { return $false }
        $processId = 0
        if (-not [int]::TryParse([string]$snapshot.pid, [ref]$processId) -or $processId -le 0) { return $false }
        foreach ($field in @('started_at','captured_at')) {
            $parsed = [datetimeoffset]::MinValue
            if (-not [datetimeoffset]::TryParse([string]$snapshot.$field, [ref]$parsed)) { return $false }
        }
    }
    # Version 2 requires a complete incumbent snapshot, but does not authorize mutation.
    if ([long]$Journal.schema_version -eq 2) {
        if ($null -eq $Journal.PSObject.Properties['incumbent'] -or $null -eq $Journal.incumbent) { return $false }
    }
    # Only PREPARED journals are trusted; operational states remain disabled.
    return $true
}
