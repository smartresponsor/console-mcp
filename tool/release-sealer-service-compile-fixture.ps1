# Isolated compilation only. No Service Control Manager operations.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_BUILD_WINDOWS_REQUIRED'}
$project=Join-Path $PSScriptRoot '../ops/windows-sealer-service/ConsoleMcp.Sealer.Service.csproj'
if(-not (Test-Path -LiteralPath $project -PathType Leaf)){throw 'RELEASE_SEAL_BUILD_PROJECT_MISSING'}
$dotnet=Get-Command dotnet -ErrorAction SilentlyContinue
if($null -eq $dotnet){
 @{status='RELEASE_SEAL_DOTNET_SDK_UNAVAILABLE';compiled=$false;production_changed=$false} | ConvertTo-Json -Compress
 return
}
$sdks=@(& $dotnet.Source --list-sdks 2>$null)
if($LASTEXITCODE -ne 0 -or $sdks.Count -eq 0){
 @{status='RELEASE_SEAL_DOTNET_SDK_UNAVAILABLE';compiled=$false;production_changed=$false} | ConvertTo-Json -Compress
 return
}
$version=& $dotnet.Source --version
if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_DOTNET_SDK_INVALID'}
$parts=[string]$version -split '\.'
if([int]$parts[0] -lt 8){throw 'RELEASE_SEAL_DOTNET_SDK_TOO_OLD'}
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($sourceRoot -notlike '*sealing-acl-fixture-*'){
 throw 'RELEASE_SEAL_BUILD_DISPOSABLE_WORKSPACE_REQUIRED'
}
& $dotnet.Source build $project --configuration Release --nologo --verbosity quiet
if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_SERVICE_BUILD_FAILED'}
$assembly=Join-Path (Split-Path -Parent $project) 'bin/Release/net8.0-windows/ConsoleMcp.Sealer.Service.dll'
if(-not (Test-Path -LiteralPath $assembly -PathType Leaf)){throw 'RELEASE_SEAL_SERVICE_BUILD_OUTPUT_MISSING'}
@{status='RELEASE_SEAL_SERVICE_BUILD_PASS';sdk=[string]$version;
  assembly_sha256=(Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash.ToLowerInvariant();
  compiled=$true;service_installed=$false;production_changed=$false} | ConvertTo-Json -Compress
