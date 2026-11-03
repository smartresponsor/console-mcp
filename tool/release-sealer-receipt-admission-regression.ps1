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
'RELEASE_SEALER_RECEIPT_ADMISSION_REGRESSION_PASS'
