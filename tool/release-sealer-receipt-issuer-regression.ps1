$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/75-release-v3-sealer-receipt-issuer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/78-release-v3-seal-receipt.ps1')
$rsa=[Security.Cryptography.RSA]::Create(3072)
try {
 $data=[ordered]@{
  request_id=('a'*32);release_id=('b'*40);source_sha=('c'*40)
  inventory_sha256=('d'*64);rollback_release_id=('e'*40)
  release_path='C:\\ConsoleMcp\\.releases\\bbbb';parent_path_identity='fixture-parent-id'
  verified_file_count=2;acl_policy_version=1
  sealed_at=[datetimeoffset]::UtcNow.ToString('o')
 }
 $envelope=New-ReleaseV3SealerReceiptSignature -Evidence $data -PrivateSigningKey $rsa
 $result=Assert-ReleaseV3SignedSealReceipt -Envelope $envelope -TrustedPublicKeyPem $rsa.ExportSubjectPublicKeyInfoPem() `
  -ExpectedRequestId $data.request_id -ExpectedReleaseId $data.release_id -ExpectedSourceSha $data.source_sha `
  -ExpectedInventorySha256 $data.inventory_sha256 -ExpectedRollbackReleaseId $data.rollback_release_id `
  -ExpectedReleasePath $data.release_path -ExpectedParentPathIdentity $data.parent_path_identity
 if(-not $result.signature_verified -or $result.authorization_granted){throw 'ISSUER_ROUNDTRIP_INVALID'}
 foreach($case in @(
  @{name='malformed-source';field='source_sha';value=('g'*40);error='RELEASE_SEAL_ISSUER_BINDING_INVALID'},
  @{name='same-rollback';field='rollback_release_id';value=('b'*40);error='RELEASE_SEAL_ISSUER_BINDING_INVALID'},
  @{name='bad-count';field='verified_file_count';value=0;error='RELEASE_SEAL_ISSUER_BINDING_INVALID'},
  @{name='control-character';field='release_path';value="broken`npath";error='RELEASE_SEAL_ISSUER_PATH_INVALID'}
 )){
  $bad=[ordered]@{};foreach($k in $data.Keys){$bad[$k]=$data[$k]}
  $bad[$case.field]=$case.value
  $blocked=$false
  try{$null=New-ReleaseV3SealerReceiptSignature -Evidence $bad -PrivateSigningKey $rsa}catch{$blocked=$_.Exception.Message -eq $case.error}
  if(-not $blocked){throw ('ISSUER_NEGATIVE_ACCEPTED: '+$case.name)}
 }
 $extra=[ordered]@{};foreach($k in $data.Keys){$extra[$k]=$data[$k]};$extra.unexpected='not allowed'
 $blocked=$false
 try{$null=New-ReleaseV3SealerReceiptSignature -Evidence $extra -PrivateSigningKey $rsa}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_ISSUER_FIELDS_INVALID'}
 if(-not $blocked){throw 'ISSUER_EXTRA_FIELD_ACCEPTED'}
 $small=[Security.Cryptography.RSA]::Create(2048)
 try{
  $blocked=$false
  try{$null=New-ReleaseV3SealerReceiptSignature -Evidence $data -PrivateSigningKey $small}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_ISSUER_SIGNING_KEY_TOO_SMALL'}
  if(-not $blocked){throw 'ISSUER_WEAK_KEY_ACCEPTED'}
 }finally{$small.Dispose()}
 if(-not $IsWindows){
  $blocked=$false
  try{$null=New-ReleaseV3SealerHostReceiptSignature -Evidence $data -PrivateSigningKey $rsa}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_WINDOWS_HOST_REQUIRED'}
  if(-not $blocked){throw 'NONWINDOWS_ISSUER_GATE_ACCEPTED'}
 }
 'RELEASE_SEALER_RECEIPT_ISSUER_REGRESSION_PASS'
}finally{$rsa.Dispose()}
