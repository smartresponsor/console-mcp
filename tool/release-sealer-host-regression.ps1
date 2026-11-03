$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1')
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1') -Raw
$wrapper=$source.Substring($source.IndexOf('function Assert-ReleaseV3SealerAuthenticatedHostRequest'),$source.IndexOf('function Get-ReleaseV3SealRequestCanonicalBytes')-$source.IndexOf('function Assert-ReleaseV3SealerAuthenticatedHostRequest'))
if($wrapper -match 'param\([^)]*ServiceIdentity' -or
   $wrapper -notmatch 'Assert-ReleaseV3SealerHostIdentity' -or
   $wrapper -notmatch 'authorization_granted=\$false'){
    throw 'SEALER_HOST_WRAPPER_TRUST_BOUNDARY_INVALID'
}
$now=[datetimeoffset]::UtcNow
$key=[byte[]](1..32)
$request=@{schema_version=1;operation='seal_new_release';request_id=('a'*32);
 source_sha=('b'*40);payload_inventory_sha256=('c'*64);release_id=('d'*40);
 rollback_release_id=('e'*40);expires_at=$now.AddMinutes(5).ToString('o');authority_mac=('0'*64)}
$request.authority_mac=Get-ReleaseV3SealRequestMac -Request $request -Key $key
if(-not $IsWindows){
 $blocked=$false
 try {$null=Assert-ReleaseV3SealerHostIdentity} catch {$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_WINDOWS_HOST_REQUIRED'}
 if(-not $blocked){throw 'NON_WINDOWS_HOST_IDENTITY_ACCEPTED'}
 $blocked=$false
 try {$null=Assert-ReleaseV3SealerAuthenticatedHostRequest -Request $request -Key $key -Now $now} catch {$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_WINDOWS_HOST_REQUIRED'}
 if(-not $blocked){throw 'NON_WINDOWS_AUTHENTICATED_HOST_ACCEPTED'}
} else {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
 if($identity.User.Value -cne 'S-1-5-18' -or $session -ne 0){
  $blocked=$false
  try {$null=Assert-ReleaseV3SealerHostIdentity} catch {$blocked=$_.Exception.Message -in @('RELEASE_SEAL_SYSTEM_TOKEN_REQUIRED','RELEASE_SEAL_SERVICE_SESSION_REQUIRED')}
  if(-not $blocked){throw 'UNPRIVILEGED_WINDOWS_HOST_ACCEPTED'}
 }
}
'RELEASE_SEALER_HOST_REGRESSION_PASS'
