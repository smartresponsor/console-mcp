# Self-contained build confined to isolated Windows fixture and package cache.
# No SCM registration, installation, system NuGet settings or runtime switching.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'}
$projectRoot=Join-Path $root 'ops/windows-sealer-service'
$project=Join-Path $projectRoot 'ConsoleMcp.Sealer.Service.csproj'
$dotnet=Join-Path $root '.isolated-sdk/sdk/dotnet.exe'
if(-not (Test-Path -LiteralPath $dotnet -PathType Leaf)){throw 'RELEASE_SEAL_ISOLATED_SDK_MISSING'}
$packages=Join-Path $root '.isolated-sdk/nuget-packages'
$http=Join-Path $root '.isolated-sdk/nuget-http'
$envBefore=@{DOTNET_ROOT=$env:DOTNET_ROOT;PATH=$env:PATH;NUGET_PACKAGES=$env:NUGET_PACKAGES;
 NUGET_HTTP_CACHE_PATH=$env:NUGET_HTTP_CACHE_PATH;DOTNET_CLI_TELEMETRY_OPTOUT=$env:DOTNET_CLI_TELEMETRY_OPTOUT}
$env:DOTNET_ROOT=Join-Path $root '.isolated-sdk/sdk'
$env:PATH=$env:DOTNET_ROOT+';'+$env:PATH
$env:NUGET_PACKAGES=$packages
$env:NUGET_HTTP_CACHE_PATH=$http
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
try {
 Push-Location $projectRoot
 try {
  $version=& $dotnet --version
  if($LASTEXITCODE -ne 0 -or [string]$version -cne '10.0.403'){throw 'RELEASE_SEAL_SDK_PIN_MISMATCH'}
  & $dotnet publish $project --configuration Release --runtime win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false --source 'https://api.nuget.org/v3/index.json' --nologo --verbosity quiet
  if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SELF_CONTAINED_PUBLISH_FAILED'}
 } finally {Pop-Location}
} finally {
 foreach($name in $envBefore.Keys){
  [Environment]::SetEnvironmentVariable($name,$envBefore[$name],'Process')
 }
}
$out=Join-Path $projectRoot 'bin/Release/net10.0-windows/win-x64/publish/ConsoleMcp.Sealer.Service.exe'
if(-not (Test-Path -LiteralPath $out -PathType Leaf)){throw 'RELEASE_SEAL_SELF_CONTAINED_EXE_MISSING'}
@{status='RELEASE_SEAL_SELF_CONTAINED_BUILD_PASS';sha256=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant();path=$out;
 self_contained=$true;service_installed=$false;production_changed=$false} | ConvertTo-Json -Compress
