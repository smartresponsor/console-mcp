# Privileged sealer receipt issuance primitive; no service installation or key storage.
# The caller MUST separately attest source bytes, immutable destination ACLs,
# journal reservation, transport identity, and protected private key ownership.
function New-ReleaseV3SealerReceiptPayload {
    param([Parameter(Mandatory=$true)]$Evidence)
    if($null -eq $Evidence -or $Evidence -isnot [Collections.IDictionary]){
        throw 'RELEASE_SEAL_ISSUER_EVIDENCE_INVALID'
    }
    $fields=@('request_id','release_id','source_sha','inventory_sha256',
      'rollback_release_id','release_path','parent_path_identity',
      'verified_file_count','acl_policy_version','sealed_at')
    if(@($Evidence.Keys).Count -ne $fields.Count -or
       @($fields | Where-Object {-not $Evidence.Contains($_)}).Count -gt 0){
        throw 'RELEASE_SEAL_ISSUER_FIELDS_INVALID'
    }
    if([string]$Evidence.request_id -cnotmatch '^[0-9a-f]{32}$' -or
       [string]$Evidence.release_id -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Evidence.source_sha -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Evidence.inventory_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
       [string]$Evidence.rollback_release_id -cnotmatch '^[0-9a-f]{40}$' -or
       [string]$Evidence.rollback_release_id -ceq [string]$Evidence.release_id -or
       [string]$Evidence.verified_file_count -cnotmatch '^[1-9][0-9]*$' -or
       [string]$Evidence.acl_policy_version -cne '1'){
        throw 'RELEASE_SEAL_ISSUER_BINDING_INVALID'
    }
    foreach($key in @('release_path','parent_path_identity')){
        if([string]::IsNullOrWhiteSpace([string]$Evidence[$key]) -or
           [string]$Evidence[$key] -match '[\x00-\x1f\x7f]'){
            throw 'RELEASE_SEAL_ISSUER_PATH_INVALID'
        }
    }
    $at=[datetimeoffset]::MinValue
    if(-not [datetimeoffset]::TryParse([string]$Evidence.sealed_at,[ref]$at)){
        throw 'RELEASE_SEAL_ISSUER_TIMESTAMP_INVALID'
    }
    # Property order is part of the durable wire format, not a security secret.
    return [ordered]@{
        schema_version=1
        request_id=[string]$Evidence.request_id
        release_id=[string]$Evidence.release_id
        source_sha=[string]$Evidence.source_sha
        inventory_sha256=[string]$Evidence.inventory_sha256
        rollback_release_id=[string]$Evidence.rollback_release_id
        release_path=[string]$Evidence.release_path
        parent_path_identity=[string]$Evidence.parent_path_identity
        sealer_identity='S-1-5-18'
        verified_file_count=[long]$Evidence.verified_file_count
        acl_policy_version=1
        sealed_at=[string]$Evidence.sealed_at
    }
}
function New-ReleaseV3SealerReceiptSignature {
    param([Parameter(Mandatory=$true)]$Evidence,
          [Parameter(Mandatory=$true)][Security.Cryptography.RSA]$PrivateSigningKey)
    if($PrivateSigningKey.KeySize -lt 3072){throw 'RELEASE_SEAL_ISSUER_SIGNING_KEY_TOO_SMALL'}
    $payload=New-ReleaseV3SealerReceiptPayload -Evidence $Evidence
    $bytes=[Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
    $signature=$PrivateSigningKey.SignData($bytes,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pss)
    return @{
        schema_version=1
        payload_base64=[Convert]::ToBase64String($bytes)
        signature_base64=[Convert]::ToBase64String($signature)
    }
}
# Only a Windows LocalSystem service process in Session 0 may call this host
# gateway. This still does NOT attest caller transport, journal, source or ACL.
function New-ReleaseV3SealerHostReceiptSignature {
    param([Parameter(Mandatory=$true)]$Evidence,
          [Parameter(Mandatory=$true)][Security.Cryptography.RSA]$PrivateSigningKey)
    $null=Assert-ReleaseV3SealerHostIdentity
    return New-ReleaseV3SealerReceiptSignature -Evidence $Evidence -PrivateSigningKey $PrivateSigningKey
}
