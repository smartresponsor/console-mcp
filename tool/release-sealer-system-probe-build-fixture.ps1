# Compile-only for a test-specific SYSTEM SCM probe, never installs services.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_SYSTEM_PROBE_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
 throw 'RELEASE_SEAL_SYSTEM_PROBE_ISOLATED_WORKSPACE_REQUIRED'
}
$dotnet=Join-Path $root '.isolated-sdk/sdk/dotnet.exe'
$project=Join-Path $root 'ops/windows-sealer-system-probe/ConsoleMcp.Sealer.SystemProbe.csproj'
if(-not (Test-Path -LiteralPath $dotnet -PathType Leaf)){throw 'RELEASE_SEAL_PROBE_SDK_MISSING'}
$oldEnv=@{DOTNET_ROOT=$env:DOTNET_ROOT;PATH=$env:PATH;NUGET_PACKAGES=$env:NUGET_PACKAGES;
 NUGET_HTTP_CACHE_PATH=$env:NUGET_HTTP_CACHE_PATH;DOTNET_CLI_TELEMETRY_OPTOUT=$env:DOTNET_CLI_TELEMETRY_OPTOUT}
try {
 $env:DOTNET_ROOT=Join-Path $root '.isolated-sdk/sdk'
 $env:PATH=$env:DOTNET_ROOT+';'+$env:PATH
 $env:NUGET_PACKAGES=Join-Path $root '.isolated-sdk/nuget-packages'
 $env:NUGET_HTTP_CACHE_PATH=Join-Path $root '.isolated-sdk/nuget-http'
 $env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
 $version=& $dotnet --version
 if($LASTEXITCODE -ne 0 -or [string]$version -cne '10.0.403'){throw 'RELEASE_SEAL_PROBE_SDK_PIN_MISMATCH'}
 & $dotnet publish $project --configuration Release --runtime win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false --source 'https://api.nuget.org/v3/index.json' --nologo --verbosity quiet
 if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SYSTEM_PROBE_BUILD_FAILED'}
} finally {
 foreach($name in $oldEnv.Keys){[Environment]::SetEnvironmentVariable($name,$oldEnv[$name],'Process')}
}
$exe=Join-Path $root 'ops/windows-sealer-system-probe/bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.SystemProbe.exe'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'RELEASE_SEAL_SYSTEM_PROBE_EXE_MISSING'}
@{status='SYSTEM_PROBE_BUILD_PASS';sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();service_installed=$false;production_changed=$false} | ConvertTo-Json -Compress
