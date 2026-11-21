$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/72-release-v3-sealer-service-contract.ps1')
$good=@{
 Name='ConsoleMcpReleaseSealerV3'
 StartName='LocalSystem'
 ServiceType='Own Process'
 StartMode='Disabled'
 State='Stopped'
 PathName='"C:\Program Files\ConsoleMcp\SealerV3\ConsoleMcp.Sealer.Service.exe"'
}
$proof=Assert-ReleaseV3SealerServiceRecord -Service $good
if(-not $proof.configuration_only -or $proof.service_authorized -or $proof.executable_authenticated){
 throw 'SEALER_SERVICE_RECORD_OVERCLAIMED'
}
foreach($test in @(
 @{field='Name';value='ConsoleMcp'},
 @{field='StartName';value='LocalService'},
 @{field='ServiceType';value='Share Process'},
 @{field='StartMode';value='Auto'},
 @{field='State';value='Running'},
 @{field='PathName';value='powershell.exe -File C:\temp\sealer.ps1'},
 @{field='PathName';value='"C:\Program Files\ConsoleMcp\SealerV3\ConsoleMcp.Sealer.Service.exe" --extra'}
)){
 $bad=$good.Clone();$bad[$test.field]=$test.value
 $blocked=$false
 try{$null=Assert-ReleaseV3SealerServiceRecord -Service $bad}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_SERVICE_CONFIGURATION_UNTRUSTED'}
 if(-not $blocked){throw ('SEALER_SERVICE_BAD_RECORD_ACCEPTED: '+$test.field)}
}
if(-not $IsWindows){
 $blocked=$false
 try{$null=Assert-ReleaseV3WindowsSealerServiceInstallation}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_SERVICE_WINDOWS_REQUIRED'}
 if(-not $blocked){throw 'NONWINDOWS_SERVICE_INSTALL_ADMITTED'}
}
'RELEASE_SEALER_SERVICE_CONTRACT_REGRESSION_PASS'
