$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/73-release-v3-sealer-host-code.ps1')
if(-not $IsWindows){
 $blocked=$false
 try{$null=Assert-ReleaseV3SealerHostCode -CodeRoot ([IO.Path]::GetTempPath()) -ExpectedFiles @{'host.ps1'=('a'*64)}}
 catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_HOST_CODE_WINDOWS_REQUIRED'}
 if(-not $blocked){throw 'NONWINDOWS_SEALER_HOST_CODE_ADMITTED'}
} else {
 # Use the test repo itself as the intentionally unprotected code root.
 # This must fail before accepting a single byte as service-host code.
 $root=Join-Path $PSScriptRoot 'dev-console.d'
 $file=Join-Path $root '73-release-v3-sealer-host-code.ps1'
 $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 $blocked=$false
 try{$null=Assert-ReleaseV3SealerHostCode -CodeRoot $root -ExpectedFiles @{'73-release-v3-sealer-host-code.ps1'=$hash}}
 catch{$blocked=$_.Exception.Message -match '^RELEASE_SEAL_(ACL_|HOST_CODE_)'}
 if(-not $blocked){throw 'UNPROTECTED_SEALER_HOST_CODE_ADMITTED'}
}
'RELEASE_SEALER_HOST_CODE_REGRESSION_PASS'
