$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1')
$now=[datetimeoffset]::UtcNow
$key=[byte[]](1..32)
$request=@{
 schema_version=1;operation='seal_new_release';request_id=('a'*32);source_sha=('b'*40)
 payload_inventory_sha256=('c'*64);release_id=('d'*40);rollback_release_id=('e'*40)
 expires_at=$now.AddMinutes(3).ToString('o');authority_mac=('0'*64)
}
$request.authority_mac=Get-ReleaseV3SealRequestMac -Request $request -Key $key
$proof=Assert-ReleaseV3SealerAuthenticatedRequest -Request $request -Key $key -ServiceIdentity 'S-1-5-18' -Now $now
if($proof.status -cne 'RELEASE_SEAL_REQUEST_AUTHENTICATED' -or $proof.authorization_granted -or $proof.replay_checked -or $proof.mutation_performed){throw 'AUTH_PROOF_OVERCLAIMS_AUTHORITY'}
$variants=@(
 @{name='tampered-sha';changes=@{source_sha=('f'*40)}},
 @{name='tampered-inventory';changes=@{payload_inventory_sha256=('f'*64)}},
 @{name='tampered-rollback';changes=@{rollback_release_id=('f'*40)}},
 @{name='tampered-expiry';changes=@{expires_at=$now.AddMinutes(4).ToString('o')}},
 @{name='tampered-id';changes=@{request_id=('f'*32)}}
)
foreach($variant in $variants){
 $bad=$request.Clone()
 foreach($k in $variant.changes.Keys){$bad[$k]=$variant.changes[$k]}
 $blocked=$false
 try{$null=Assert-ReleaseV3SealerAuthenticatedRequest -Request $bad -Key $key -ServiceIdentity 'S-1-5-18' -Now $now}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_MAC_INVALID'}
 if(-not $blocked){throw ('FORGED_REQUEST_ACCEPTED: '+$variant.name)}
}
$blocked=$false
try{$null=Assert-ReleaseV3SealerAuthenticatedRequest -Request $request -Key $key -ServiceIdentity 'S-1-5-21-1000' -Now $now}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_SYSTEM_IDENTITY_REQUIRED'}
if(-not $blocked){throw 'NON_SYSTEM_SERVICE_IDENTITY_ACCEPTED'}
$badKey=[byte[]](2..33)
$blocked=$false
try{$null=Assert-ReleaseV3SealerAuthenticatedRequest -Request $request -Key $badKey -ServiceIdentity 'S-1-5-18' -Now $now}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_MAC_INVALID'}
if(-not $blocked){throw 'WRONG_KEY_ACCEPTED'}
'RELEASE_SEALER_AUTH_REGRESSION_PASS'
