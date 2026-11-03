# Read-only pre-activation receipt admission. The trust anchor must be provisioned
# independently by SYSTEM and protected against the broker account. No fallback.
function Assert-ReleaseV3SealReceiptTrustAnchor {
    param([Parameter(Mandatory=$true)][string]$TrustRoot)
    if(-not $IsWindows){throw 'RELEASE_SEAL_TRUST_WINDOWS_REQUIRED'}
    $root=[IO.Path]::GetFullPath($TrustRoot)
    if(-not (Test-Path -LiteralPath $root -PathType Container)){throw 'RELEASE_SEAL_TRUST_ROOT_MISSING'}
    $parent=Split-Path -Parent $root
    $pem=Join-Path $root 'sealer-public.pem'
    foreach($path in @($parent,$root,$pem)){
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RELEASE_SEAL_TRUST_REPARSE_POINT'}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        if(-not $acl.AreAccessRulesProtected -or
           $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-18'){
            throw 'RELEASE_SEAL_TRUST_ACL_INVALID'
        }
        $mutate=[long][Security.AccessControl.FileSystemRights]::Modify -bor
                [long][Security.AccessControl.FileSystemRights]::Write -bor
                [long][Security.AccessControl.FileSystemRights]::Delete -bor
                [long][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
                [long][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                [long][Security.AccessControl.FileSystemRights]::TakeOwnership
        foreach($ace in $acl.Access){
            if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
            $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if($sid -cne 'S-1-5-18' -and (([long]$ace.FileSystemRights -band $mutate) -ne 0)){
                throw 'RELEASE_SEAL_TRUST_WRITABLE'
            }
        }
    }
    $publicKey=[IO.File]::ReadAllText($pem)
    if([string]::IsNullOrWhiteSpace($publicKey)){throw 'RELEASE_SEAL_TRUST_KEY_MISSING'}
    return $publicKey
}
function Assert-ReleaseV3SignedReceiptAdmission {
    param([Parameter(Mandatory=$true)]$State,[Parameter(Mandatory=$true)][string]$TrustRoot)
    if($null -eq $State.candidate -or $null -eq $State.previous -or
       $null -eq $State.candidate.seal -or $null -eq $State.previous.seal){
        throw 'RELEASE_SEAL_RECEIPTS_REQUIRED'
    }
    $key=Assert-ReleaseV3SealReceiptTrustAnchor -TrustRoot $TrustRoot
    foreach($kind in @('candidate','previous')){
        $descriptor=if($kind -eq 'candidate'){$State.candidate}else{$State.previous}
        $attestation=$descriptor.seal
        $required=@('envelope','request_id','release_id','source_sha',
          'inventory_sha256','rollback_release_id','release_path','parent_path_identity')
        foreach($field in $required){
            if($null -eq $attestation[$field] -or [string]$attestation[$field] -eq ''){
                throw 'RELEASE_SEAL_RECEIPT_BINDING_MISSING'
            }
        }
        if([IO.Path]::GetFullPath([string]$descriptor.root) -cne [string]$attestation.release_path){
            throw 'RELEASE_SEAL_RECEIPT_PATH_DRIFT'
        }
        if([string]$descriptor.sha -cne [string]$attestation.source_sha){
            throw 'RELEASE_SEAL_RECEIPT_SOURCE_DRIFT'
        }
        $proof=Assert-ReleaseV3SignedSealReceipt -Envelope $attestation.envelope -TrustedPublicKeyPem $key `
          -ExpectedRequestId $attestation.request_id -ExpectedReleaseId $attestation.release_id `
          -ExpectedSourceSha $attestation.source_sha -ExpectedInventorySha256 $attestation.inventory_sha256 `
          -ExpectedRollbackReleaseId $attestation.rollback_release_id -ExpectedReleasePath $attestation.release_path `
          -ExpectedParentPathIdentity $attestation.parent_path_identity
        if(-not $proof.signature_verified -or $proof.verified_file_count -ne $descriptor.files.Count){
            throw 'RELEASE_SEAL_RECEIPT_COUNT_DRIFT'
        }
        # Rehash actual payload and compare canonical size+SHA inventory to the
        # authenticated receipt for BOTH candidate and exact rollback.
        $inventoryProof=Assert-ReleaseV3ReceiptInventory -Descriptor $descriptor -ExpectedInventorySha256 $proof.inventory_sha256
        if(-not $inventoryProof.bytes_rechecked -or $inventoryProof.file_count -ne $proof.verified_file_count){
            throw 'RELEASE_SEAL_INVENTORY_ADMISSION_FAILED'
        }
    }
    return [pscustomobject]@{status='RELEASE_SEAL_RECEIPTS_VERIFIED';signature_verified=$true;
      acl_rechecked=$false;inventory_rechecked=$true;authorization_granted=$false}
}
