$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/78-release-v3-seal-receipt.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/77-release-v3-receipt-admission.ps1')
$control=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1') -Raw
$receiptGate='Assert-ReleaseV3SignedReceiptAdmission -State $State -TrustRoot $sealTrustRoot'
$aclGate='Assert-ReleaseV3SealedStorage -Descriptor $State.candidate'
if(-not $control.Contains($receiptGate) -or
   $control.IndexOf($receiptGate) -ge $control.IndexOf($aclGate)){
    throw 'RELEASE_SIGNED_RECEIPT_GATE_MISSING_OR_LATE'
}
$missing=@{candidate=@{root='C:\\fixture';files=@{};sha='a'*40};previous=@{root='C:\\fixture';files=@{};sha='b'*40}}
$blocked=$false
try{$null=Assert-ReleaseV3SignedReceiptAdmission -State $missing -TrustRoot 'C:\\not-real'}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_RECEIPTS_REQUIRED'}
if(-not $blocked){throw 'UNSIGNED_RELEASE_ADMITTED'}
if(-not $IsWindows){
 $blocked=$false
 try{$null=Assert-ReleaseV3SealReceiptTrustAnchor -TrustRoot '/tmp'}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_TRUST_WINDOWS_REQUIRED'}
 if(-not $blocked){throw 'NONWINDOWS_TRUST_ANCHOR_ADMITTED'}
}
$pair=@{
 candidate=@{sha=('a'*40);seal=@{request_id=('1'*32);release_id=('b'*40);rollback_release_id=('c'*40);source_sha=('a'*40)}}
 previous=@{sha=('d'*40);seal=@{request_id=('2'*32);release_id=('c'*40);rollback_release_id=('e'*40);source_sha=('d'*40)}}
}
$pairProof=Assert-ReleaseV3SealReceiptPairBinding -State $pair
if($pairProof.authorization_granted -or $pairProof.authenticated){throw 'UNAUTHENTICATED_PAIR_OVERCLAIMED'}
$pair.previous.seal.release_id='f'*40
$blocked=$false
try{$null=Assert-ReleaseV3SealReceiptPairBinding -State $pair}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_PAIR_ROLLBACK_MISMATCH'}
if(-not $blocked){throw 'UNRELATED_ROLLBACK_RECEIPT_ACCEPTED'}
$pair.previous.seal.release_id='c'*40
$pair.previous.sha='previous-runtime-content-attested'
$blocked=$false
try{$null=Assert-ReleaseV3SealReceiptPairBinding -State $pair}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_PAIR_SOURCE_ID_INVALID'}
if(-not $blocked){throw 'LEGACY_ROLLBACK_SOURCE_ACCEPTED'}
$pair.previous.sha='d'*40
$pair.previous.seal.request_id='1'*32
$blocked=$false
try{$null=Assert-ReleaseV3SealReceiptPairBinding -State $pair}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_PAIR_ROLLBACK_MISMATCH'}
if(-not $blocked){throw 'DUPLICATE_SEAL_REQUEST_ACCEPTED'}
'RELEASE_SEALER_RECEIPT_ADMISSION_REGRESSION_PASS'
