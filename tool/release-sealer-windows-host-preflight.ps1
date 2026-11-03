# Native, read-only readiness probe for an independently provisioned sealer.
# Does not launch elevated processes, mutate ACLs, create keys or install services.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_PREFLIGHT_REQUIRED'}
. (Join-Path $PSScriptRoot 'dev-console.d/74-release-v3-acl-policy.ps1')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=[string]$identity.User.Value
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$systemHost=($sid -ceq 'S-1-5-18' -and $session -eq 0)
$root=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ConsoleMcp/seal-authority'
$pem=Join-Path $root 'sealer-public.pem'
$trustExists=Test-Path -LiteralPath $pem -PathType Leaf
$trustProtected=$false
$trustError=''
if($trustExists){
    try {
        $null=Assert-ReleaseV3WindowsProtectedPath -Path $pem
        $trustProtected=$true
    } catch {$trustError=$_.Exception.Message}
}
$ready=($systemHost -and $trustExists -and $trustProtected)
[pscustomobject]@{
    status=if($ready){'RELEASE_SEAL_PREFLIGHT_HOST_AND_TRUST_READY'}else{'RELEASE_SEAL_PREFLIGHT_NOT_READY'}
    process_sid=$sid
    session_id=$session
    system_host=$systemHost
    trust_anchor_exists=$trustExists
    trust_anchor_acl_verified=$trustProtected
    trust_error=$trustError
    # Host/key checks alone do not establish transport, journal, source, or
    # protected private-key provenance; no deployment authorization is issued.
    service_installed_verified=$false
    transport_authenticated=$false
    journal_verified=$false
    private_key_verified=$false
    authorization_granted=$false
    production_changed=$false
} | ConvertTo-Json -Compress
