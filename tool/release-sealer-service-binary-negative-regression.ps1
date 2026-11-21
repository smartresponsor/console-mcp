# Native fixture: the newly compiled service EXE must refuse all ordinary
# interactive-user and argument-driven invocation, without SCM registration.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_BINARY_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
    throw 'RELEASE_SEAL_BINARY_ISOLATED_WORKSPACE_REQUIRED'
}
$exe=Join-Path $root 'ops/windows-sealer-service/bin/Release/net10.0-windows/ConsoleMcp.Sealer.Service.exe'
$sdk=Join-Path $root '.isolated-sdk/sdk'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
   -not (Test-Path -LiteralPath (Join-Path $sdk 'dotnet.exe') -PathType Leaf)){
    throw 'RELEASE_SEAL_BINARY_OR_LOCAL_RUNTIME_MISSING'
}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($owner -ceq 'S-1-5-18'){throw 'RELEASE_SEAL_BINARY_TEST_REQUIRES_USER_SESSION'}
$original=$env:DOTNET_ROOT
$originalPreference=$PSNativeCommandUseErrorActionPreference
try {
    $env:DOTNET_ROOT=$sdk
    $PSNativeCommandUseErrorActionPreference=$false
    & $exe
    $withoutArguments=$LASTEXITCODE
    & $exe '--install'
    $withArguments=$LASTEXITCODE
    if($withoutArguments -ne 5 -or $withArguments -ne 5){
        throw 'RELEASE_SEAL_BINARY_INTERACTIVE_LAUNCH_ACCEPTED'
    }
    @{status='RELEASE_SEAL_BINARY_INTERACTIVE_DENIED';no_args_exit=$withoutArguments;
      argument_exit=$withArguments;service_installed=$false;
      runtime_changed=$false;production_changed=$false} | ConvertTo-Json -Compress
} finally {
    $env:DOTNET_ROOT=$original
    $PSNativeCommandUseErrorActionPreference=$originalPreference
}
