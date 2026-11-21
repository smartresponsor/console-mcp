# Read-only discovery of the fixed Windows SCM sealer identity and exact
# initially-disabled installation contract. Never installs, starts or modifies.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SERVICE_WINDOWS_REQUIRED'}
. (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/72-release-v3-sealer-service-contract.ps1')
$status='RELEASE_SEAL_SERVICE_NOT_INSTALLED'
$errorCode=''
try {
    $null=Assert-ReleaseV3WindowsSealerServiceInstallation
    $status='RELEASE_SEAL_SERVICE_INSTALLATION_READONLY_VERIFIED'
} catch {
    $errorCode=$_.Exception.Message
    if($errorCode -notin @('RELEASE_SEAL_SERVICE_NOT_INSTALLED',
      'RELEASE_SEAL_SERVICE_CONFIGURATION_UNTRUSTED',
      'RELEASE_SEAL_SERVICE_EXECUTABLE_MISSING') -and
       $errorCode -notmatch '^RELEASE_SEAL_ACL_'){
        throw
    }
    $status='RELEASE_SEAL_SERVICE_NOT_READY'
}
[pscustomobject]@{
    status=$status
    evidence_error=$errorCode
    fixed_service_name='ConsoleMcpReleaseSealerV3'
    service_installed_verified=($status -eq 'RELEASE_SEAL_SERVICE_INSTALLATION_READONLY_VERIFIED')
    transport_authenticated=$false
    private_key_verified=$false
    authorization_granted=$false
    production_changed=$false
} | ConvertTo-Json -Compress
