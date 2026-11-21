$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_PROTOCOL_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'}
$sdkRoot=Join-Path $root '.isolated-sdk/sdk'
$dotnet=Join-Path $sdkRoot 'dotnet.exe'
$project=Join-Path $root 'ops/windows-sealer-protocol-regression/ConsoleMcp.Sealer.ProtocolRegression.csproj'
if(-not (Test-Path -LiteralPath $dotnet -PathType Leaf)){throw 'RELEASE_SEAL_PROTOCOL_SDK_MISSING'}
$priorRoot=$env:DOTNET_ROOT
$priorPath=$env:PATH
try {
 $env:DOTNET_ROOT=$sdkRoot
 $env:PATH=$sdkRoot+';'+$env:PATH
 & $dotnet build $project --configuration Release --nologo --verbosity quiet
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_PROTOCOL_BUILD_FAILED'}
 $dll=Join-Path $root 'ops/windows-sealer-protocol-regression/bin/Release/net10.0-windows/ConsoleMcp.Sealer.ProtocolRegression.dll'
 & $dotnet $dll
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_PROTOCOL_TEST_FAILED'}
} finally {
 $env:DOTNET_ROOT=$priorRoot
 $env:PATH=$priorPath
}
