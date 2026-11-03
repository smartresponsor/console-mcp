# Read-only admission before any isolated native SCM lifecycle fixture.
# Never install, start, stop or delete a service.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SCM_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
 throw 'RELEASE_SEAL_SCM_ISOLATED_WORKSPACE_REQUIRED'
}
$exe=Join-Path $root 'ops/windows-sealer-service/bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.Service.exe'
$expected='7abb51696b0f966a6d813a2c4105768c0192b7402ddd2e60f6bcca31ef176e27'
$present=Test-Path -LiteralPath $exe -PathType Leaf
$hashGood=$present -and (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $expected
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$service=Get-CimInstance -ClassName Win32_Service -Filter "Name='ConsoleMcpReleaseSealerV3'" -ErrorAction Stop
$collision=$null -ne $service
@{
 status=if($elevated -and $hashGood -and -not $collision){'RELEASE_SEAL_SCM_FIXTURE_INSTALL_ELIGIBLE'}else{'RELEASE_SEAL_SCM_FIXTURE_BLOCKED'}
 process_sid=$identity.User.Value
 elevated=$elevated
 binary_present=$present
 exact_binary_hash=$hashGood
 target_service_exists=$collision
 target_service_name='ConsoleMcpReleaseSealerV3'
 install_performed=$false
 production_changed=$false
} | ConvertTo-Json -Compress
