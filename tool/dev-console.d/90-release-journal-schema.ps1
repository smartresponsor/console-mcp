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
    if ([long]$Journal.schema_version -ne 1) { return $false }
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
    # Version 1 only describes PREPARE; no operational journal states are trusted.
    return $true
}
