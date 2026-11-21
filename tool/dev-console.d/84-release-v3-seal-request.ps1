# Pure schema validation only; this does NOT authenticate or authorize a seal.
# SYSTEM sealer must independently verify MAC, request replay and source evidence.
function Assert-ReleaseV3SealRequestShape {
    param([Parameter(Mandatory=$true)]$Request,[datetimeoffset]$Now=[datetimeoffset]::UtcNow)
    if($null -eq $Request){throw 'RELEASE_SEAL_REQUEST_REQUIRED'}
    $keys=@('schema_version','operation','request_id','source_sha','payload_inventory_sha256','release_id','rollback_release_id','expires_at','authority_mac')
    $received=@($Request.Keys)
    if(@($received | Where-Object {$_ -notin $keys}).Count -gt 0 -or
        @($keys | Where-Object {$_ -notin $received}).Count -gt 0){throw 'RELEASE_SEAL_REQUEST_FIELDS_INVALID'}
    if([int]$Request.schema_version -ne 1 -or [string]$Request.operation -cne 'seal_new_release'){
        throw 'RELEASE_SEAL_REQUEST_SCHEMA_INVALID'
    }
    if([string]$Request.request_id -cnotmatch '^[0-9a-f]{32}$' -or
       [string]$Request.source_sha -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Request.payload_inventory_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
       [string]$Request.release_id -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Request.rollback_release_id -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Request.authority_mac -cnotmatch '^[0-9a-f]{64}$'){
        throw 'RELEASE_SEAL_REQUEST_IDENTIFIER_INVALID'
    }
    if([string]$Request.release_id -ceq [string]$Request.rollback_release_id){throw 'RELEASE_SEAL_SELF_ROLLBACK'}
    $expires=[datetimeoffset]::MinValue
    if(-not [datetimeoffset]::TryParse([string]$Request.expires_at,[ref]$expires)){
        throw 'RELEASE_SEAL_EXPIRY_INVALID'
    }
    if($expires -le $Now -or $expires -gt $Now.AddMinutes(10)){throw 'RELEASE_SEAL_REQUEST_EXPIRED_OR_UNBOUNDED'}
    return [pscustomobject]@{
        status='RELEASE_SEAL_REQUEST_SHAPE_VALID'
        source_sha=[string]$Request.source_sha
        release_id=[string]$Request.release_id
        rollback_release_id=[string]$Request.rollback_release_id
        authenticated=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}

