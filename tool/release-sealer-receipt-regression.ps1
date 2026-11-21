$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/78-release-v3-seal-receipt.ps1')
$rsa=[Security.Cryptography.RSA]::Create(3072)
try {
  $pub=$rsa.ExportSubjectPublicKeyInfoPem()
  $receipt=[ordered]@{
    schema_version=1;request_id=('a'*32);release_id=('b'*40);source_sha=('c'*40)
    inventory_sha256=('d'*64);rollback_release_id=('e'*40)
    release_path='C:\\ConsoleMcp\\.releases\\bbbb';parent_path_identity='fixture-parent-id'
    sealer_identity='S-1-5-18';verified_file_count=2;acl_policy_version=1
    sealed_at=[datetimeoffset]::UtcNow.ToString('o')
  }
  $bytes=[Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
  $signature=$rsa.SignData($bytes,[Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pss)
  $envelope=@{schema_version=1;payload_base64=[Convert]::ToBase64String($bytes);
    signature_base64=[Convert]::ToBase64String($signature)}
  $args=@{Envelope=$envelope;TrustedPublicKeyPem=$pub;ExpectedRequestId=$receipt.request_id;
    ExpectedReleaseId=$receipt.release_id;ExpectedSourceSha=$receipt.source_sha;
    ExpectedInventorySha256=$receipt.inventory_sha256;
    ExpectedRollbackReleaseId=$receipt.rollback_release_id;
    ExpectedReleasePath=$receipt.release_path;
    ExpectedParentPathIdentity=$receipt.parent_path_identity}
  $proof=Assert-ReleaseV3SignedSealReceipt @args
  if($proof.status -cne 'RELEASE_SEAL_RECEIPT_SIGNATURE_VERIFIED' -or
     -not $proof.signature_verified -or $proof.acl_rechecked -or
     $proof.authorization_granted){throw 'RECEIPT_SIGNATURE_PROOF_INVALID'}
  foreach($field in @('ExpectedRequestId','ExpectedReleaseId','ExpectedSourceSha','ExpectedInventorySha256','ExpectedRollbackReleaseId','ExpectedReleasePath','ExpectedParentPathIdentity')){
    $tampered=$args.Clone()
    $tampered[$field]='different-value'
    $blocked=$false
    try{$null=Assert-ReleaseV3SignedSealReceipt @tampered}catch{$blocked=$true}
    if(-not $blocked){throw ('RECEIPT_WRONG_EXPECTED_VALUE_ACCEPTED: '+$field)}
  }
  $tampered=$envelope.Clone()
  $changed=[byte[]]$bytes.Clone();$changed[20]=$changed[20] -bxor 1
  $tampered.payload_base64=[Convert]::ToBase64String($changed)
  $blocked=$false
  $badArgs=$args.Clone();$badArgs.Envelope=$tampered
  try{$null=Assert-ReleaseV3SignedSealReceipt @badArgs}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_RECEIPT_SIGNATURE_INVALID'}
  if(-not $blocked){throw 'RECEIPT_PAYLOAD_TAMPER_ACCEPTED'}
  $other=[Security.Cryptography.RSA]::Create(3072)
  try {
    $bad=$args.Clone();$bad.TrustedPublicKeyPem=$other.ExportSubjectPublicKeyInfoPem()
    $blocked=$false
    try{$null=Assert-ReleaseV3SignedSealReceipt @bad}catch{$blocked=$true}
    if(-not $blocked){throw 'RECEIPT_WRONG_TRUST_KEY_ACCEPTED'}
  } finally {$other.Dispose()}
  'RELEASE_SEALER_RECEIPT_REGRESSION_PASS'
} finally {$rsa.Dispose()}
