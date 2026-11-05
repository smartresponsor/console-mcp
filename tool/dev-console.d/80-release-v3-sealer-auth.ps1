# Authentication primitives for a separately deployed Windows SYSTEM sealer.
# Pure: never reads authority keys, mutates ACLs, or performs deployment.
# Trusted host check: never accept a caller-supplied SID as security evidence.
# On the deployed Windows sealer this must run inside its own service process.
function Assert-ReleaseV3SealerHostIdentity {
    if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_HOST_REQUIRED'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if($null -eq $identity -or $null -eq $identity.User -or
       $identity.User.Value -cne 'S-1-5-18'){
        throw 'RELEASE_SEAL_SYSTEM_TOKEN_REQUIRED'
    }
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    if($session -ne 0){throw 'RELEASE_SEAL_SERVICE_SESSION_REQUIRED'}
    return [pscustomobject]@{
        status='RELEASE_SEAL_SYSTEM_HOST_VERIFIED'
        process_id=$PID
        token_sid=$identity.User.Value
        session_id=$session
        transport_authenticated=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
function Assert-ReleaseV3SealerAuthenticatedHostRequest {
    param([Parameter(Mandatory=$true)]$Request,
          [Parameter(Mandatory=$true)][byte[]]$Key,
          [datetimeoffset]$Now=[datetimeoffset]::UtcNow)
    $hostProof=Assert-ReleaseV3SealerHostIdentity
    $proof=Assert-ReleaseV3SealerAuthenticatedRequest -Request $Request -Key $Key -ServiceIdentity $hostProof.token_sid -Now $Now
    return [pscustomobject]@{
        status='RELEASE_SEAL_HOST_REQUEST_AUTHENTICATED'
        host=$hostProof
        request=$proof
        replay_checked=$false
        transport_authenticated=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
function Get-ReleaseV3SealRequestCanonicalBytes {
    param([Parameter(Mandatory=$true)]$Request)
    $null=Assert-ReleaseV3SealRequestShape -Request $Request
    $fields=@('schema_version','operation','request_id','source_sha',
        'payload_inventory_sha256','release_id','rollback_release_id','expires_at')
    $rows=[Collections.Generic.List[string]]::new()
    foreach($name in $fields){
        $value=[string]$Request[$name]
        if($value -match '[\x00-\x1f\x7f]'){throw 'RELEASE_SEAL_REQUEST_CANONICAL_INVALID'}
        $n=[Text.Encoding]::UTF8.GetByteCount($name)
        $v=[Text.Encoding]::UTF8.GetByteCount($value)
        $rows.Add(('{0}:{1}:{2}:{3}' -f $n,$name,$v,$value))
    }
    $payload="console-mcp-seal-request-v1" + "`n" + ($rows -join "`n") + "`n"
    return ,([Text.Encoding]::UTF8.GetBytes($payload))
}
function Get-ReleaseV3SealRequestMac {
    param([Parameter(Mandatory=$true)]$Request,[Parameter(Mandatory=$true)][byte[]]$Key)
    if($Key.Length -ne 32){throw 'RELEASE_SEAL_KEY_LENGTH_INVALID'}
    $bytes=Get-ReleaseV3SealRequestCanonicalBytes -Request $Request
    $hmac=[Security.Cryptography.HMACSHA256]::new($Key)
    try{return [Convert]::ToHexString($hmac.ComputeHash($bytes)).ToLowerInvariant()}
    finally{$hmac.Dispose()}
}
function Assert-ReleaseV3SealerAuthenticatedRequest {
    param(
        [Parameter(Mandatory=$true)]$Request,
        [Parameter(Mandatory=$true)][byte[]]$Key,
        [Parameter(Mandatory=$true)][string]$ServiceIdentity,
        [datetimeoffset]$Now=[datetimeoffset]::UtcNow
    )
    $null=Assert-ReleaseV3SealRequestShape -Request $Request -Now $Now
    if($ServiceIdentity -cne 'S-1-5-18'){throw 'RELEASE_SEAL_SYSTEM_IDENTITY_REQUIRED'}
    $actual=Get-ReleaseV3SealRequestMac -Request $Request -Key $Key
    $supplied=[Convert]::FromHexString([string]$Request.authority_mac)
    $calculated=[Convert]::FromHexString($actual)
    if(-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($supplied,$calculated)){
        throw 'RELEASE_SEAL_MAC_INVALID'
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_REQUEST_AUTHENTICATED'
        request_id=[string]$Request.request_id
        source_sha=[string]$Request.source_sha
        release_id=[string]$Request.release_id
        replay_checked=$false
        source_verified=$false
        authorization_granted=$false
        mutation_performed=$false
    }
}
