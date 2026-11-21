# Pure independent verification of a privileged sealer's signed receipt.
# The private signing key MUST never be available to the developer or broker.
# No deployment is authorized by this proof in isolation.
function Assert-ReleaseV3SignedSealReceipt {
    param(
        [Parameter(Mandatory=$true)]$Envelope,
        [Parameter(Mandatory=$true)][string]$TrustedPublicKeyPem,
        [Parameter(Mandatory=$true)][string]$ExpectedRequestId,
        [Parameter(Mandatory=$true)][string]$ExpectedReleaseId,
        [Parameter(Mandatory=$true)][string]$ExpectedSourceSha,
        [Parameter(Mandatory=$true)][string]$ExpectedInventorySha256,
        [Parameter(Mandatory=$true)][string]$ExpectedRollbackReleaseId,
        [Parameter(Mandatory=$true)][string]$ExpectedReleasePath,
        [Parameter(Mandatory=$true)][string]$ExpectedParentPathIdentity,
        [datetimeoffset]$Now=[datetimeoffset]::UtcNow
    )
    if($null -eq $Envelope -or $null -eq $Envelope.Keys -or
       @($Envelope.Keys).Count -ne 3 -or
       @('schema_version','payload_base64','signature_base64' | Where-Object { -not $Envelope.ContainsKey($_) }).Count -ne 0 -or
       [string]$Envelope.schema_version -cne '1'){
        throw 'RELEASE_SEAL_RECEIPT_ENVELOPE_INVALID'
    }
    if([string]$Envelope.payload_base64 -cnotmatch '^[A-Za-z0-9+/]+={0,2}$' -or
       [string]$Envelope.signature_base64 -cnotmatch '^[A-Za-z0-9+/]+={0,2}$'){
        throw 'RELEASE_SEAL_RECEIPT_ENCODING_INVALID'
    }
    try {
        $payloadBytes=[Convert]::FromBase64String([string]$Envelope.payload_base64)
        $signature=[Convert]::FromBase64String([string]$Envelope.signature_base64)
    } catch {throw 'RELEASE_SEAL_RECEIPT_ENCODING_INVALID'}
    if($payloadBytes.Length -gt 32768 -or $payloadBytes.Length -lt 2 -or $signature.Length -lt 64){
        throw 'RELEASE_SEAL_RECEIPT_SIZE_INVALID'
    }
    $rsa=[Security.Cryptography.RSA]::Create()
    try {
        try {$rsa.ImportFromPem($TrustedPublicKeyPem)}
        catch {throw 'RELEASE_SEAL_RECEIPT_TRUST_KEY_INVALID'}
        if($rsa.KeySize -lt 3072){throw 'RELEASE_SEAL_RECEIPT_TRUST_KEY_TOO_SMALL'}
        $verified=$rsa.VerifyData($payloadBytes,$signature,
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pss)
        if(-not $verified){throw 'RELEASE_SEAL_RECEIPT_SIGNATURE_INVALID'}
    } finally {$rsa.Dispose()}
    try {
        $text=[Text.UTF8Encoding]::new($false,$true).GetString($payloadBytes)
        $receipt=ConvertFrom-Json -InputObject $text -AsHashtable -DateKind String
    } catch {throw 'RELEASE_SEAL_RECEIPT_PAYLOAD_INVALID'}
    if($null -eq $receipt -or $receipt -isnot [Collections.IDictionary] -or
       @($receipt.Keys).Count -ne 12){throw 'RELEASE_SEAL_RECEIPT_FIELDS_INVALID'}
    $fields=@('schema_version','request_id','release_id','source_sha','inventory_sha256',
        'rollback_release_id','release_path','parent_path_identity','sealer_identity','verified_file_count','acl_policy_version','sealed_at')
    if(@($fields | Where-Object {-not $receipt.ContainsKey($_)}).Count -ne 0){
        throw 'RELEASE_SEAL_RECEIPT_FIELDS_INVALID'
    }
    if([string]$receipt.schema_version -cne '1' -or
       [string]$receipt.request_id -cne $ExpectedRequestId -or
       [string]$receipt.release_id -cne $ExpectedReleaseId -or
       [string]$receipt.source_sha -cne $ExpectedSourceSha -or
       [string]$receipt.inventory_sha256 -cne $ExpectedInventorySha256 -or
       [string]$receipt.rollback_release_id -cne $ExpectedRollbackReleaseId -or
       [string]$receipt.release_path -cne $ExpectedReleasePath -or
       [string]$receipt.parent_path_identity -cne $ExpectedParentPathIdentity -or
       [string]$receipt.sealer_identity -cne 'S-1-5-18' -or
       [string]$receipt.verified_file_count -cnotmatch '^[1-9][0-9]*$' -or
       [string]$receipt.acl_policy_version -cne '1'){
        throw 'RELEASE_SEAL_RECEIPT_BINDING_INVALID'
    }
    $timestamp=[datetimeoffset]::MinValue
    if(-not [datetimeoffset]::TryParse([string]$receipt.sealed_at,[ref]$timestamp)){
        throw 'RELEASE_SEAL_RECEIPT_TIMESTAMP_INVALID'
    }
    if($timestamp -gt $Now.AddMinutes(1) -or $timestamp -lt $Now.AddMinutes(-10)){
        throw 'RELEASE_SEAL_RECEIPT_TIMESTAMP_STALE'
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_RECEIPT_SIGNATURE_VERIFIED'
        request_id=[string]$receipt.request_id
        release_id=[string]$receipt.release_id
        source_sha=[string]$receipt.source_sha
        inventory_sha256=[string]$receipt.inventory_sha256
        verified_file_count=[int64]$receipt.verified_file_count
        signature_verified=$true
        acl_rechecked=$false
        replay_checked=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
