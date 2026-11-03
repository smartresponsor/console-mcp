# Exercise published self-contained service binary without installed runtime.
# Only under interactive user inside disposable fixture, never SCM installation.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SELF_CONTAINED_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'}
$exe=Join-Path $root 'ops/windows-sealer-service/bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.Service.exe'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'RELEASE_SEAL_SELF_CONTAINED_BINARY_MISSING'}
$expected='7e9eb3911de8d49ca2136cc99ec1079a1e2ce9c0edf5b20ed2941c2a7da73e60'
$sha=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if($sha -cne $expected){throw 'RELEASE_SEAL_SELF_CONTAINED_BINARY_HASH_DRIFT'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($sid -ceq 'S-1-5-18'){throw 'RELEASE_SEAL_NEGATIVE_REQUIRES_INTERACTIVE_USER'}
$priorRoot=$env:DOTNET_ROOT
$priorPreference=$PSNativeCommandUseErrorActionPreference
try {
 # The published EXE must not depend on the SDK used to build it.
 $env:DOTNET_ROOT=''
 $PSNativeCommandUseErrorActionPreference=$false
 & $exe
 $plain=$LASTEXITCODE
 & $exe '--install'
 $install=$LASTEXITCODE
 if($plain -ne 5 -or $install -ne 5){throw 'RELEASE_SEAL_SELF_CONTAINED_USER_ACCEPTED'}
 @{status='RELEASE_SEAL_SELF_CONTAINED_NEGATIVE_PASS';sha256=$sha;no_args_exit=$plain;
  install_argument_exit=$install;service_installed=$false;production_changed=$false} | ConvertTo-Json -Compress
} finally {
 $env:DOTNET_ROOT=$priorRoot
 $PSNativeCommandUseErrorActionPreference=$priorPreference
}
