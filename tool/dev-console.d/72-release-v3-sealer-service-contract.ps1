# Windows Service Control Manager admission contract for a future dedicated
# noninteractive, independently installed sealer executable. No install/start.
function Assert-ReleaseV3SealerServiceRecord {
    param([Parameter(Mandatory=$true)]$Service)
    if($null -eq $Service -or
       [string]$Service.Name -cne 'ConsoleMcpReleaseSealerV3' -or
       [string]$Service.StartName -cnotin @('LocalSystem','NT AUTHORITY\SYSTEM') -or
       [string]$Service.ServiceType -cne 'Own Process' -or
       [string]$Service.StartMode -cne 'Disabled' -or
       [string]$Service.State -cne 'Stopped' -or
       [string]$Service.PathName -cne '"C:\Program Files\ConsoleMcp\SealerV3\ConsoleMcp.Sealer.Service.exe"'){
        throw 'RELEASE_SEAL_SERVICE_CONFIGURATION_UNTRUSTED'
    }
    return [pscustomobject]@{
        status='RELEASE_SEAL_SERVICE_RECORD_MATCHED'
        service_name='ConsoleMcpReleaseSealerV3'
        configuration_only=$true
        executable_authenticated=$false
        process_token_authenticated=$false
        service_authorized=$false
        mutation_performed=$false
    }
}
function Assert-ReleaseV3WindowsSealerServiceInstallation {
    if(-not $IsWindows){throw 'RELEASE_SEAL_SERVICE_WINDOWS_REQUIRED'}
    $name='ConsoleMcpReleaseSealerV3'
    # Exact service name is fixed, never caller-supplied or interpolated.
    $svc=Get-CimInstance -ClassName Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
    if($null -eq $svc){throw 'RELEASE_SEAL_SERVICE_NOT_INSTALLED'}
    $proof=Assert-ReleaseV3SealerServiceRecord -Service $svc
    $exe='C:\Program Files\ConsoleMcp\SealerV3\ConsoleMcp.Sealer.Service.exe'
    if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){
        throw 'RELEASE_SEAL_SERVICE_EXECUTABLE_MISSING'
    }
    $null=Assert-ReleaseV3WindowsProtectedPath -Path $exe
    return [pscustomobject]@{
        status='RELEASE_SEAL_SERVICE_INSTALLATION_READONLY_VERIFIED'
        configuration_verified=$true
        executable_acl_verified=$true
        executable_authenticated=$false
        signed_code_manifest_verified=$false
        service_authorized=$false
        mutation_performed=$false
    }
}
