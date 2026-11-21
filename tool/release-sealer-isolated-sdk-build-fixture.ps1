# Build in an isolated, disposable Windows workspace only. No SDK install,
# SCM changes, production paths, runtime control, or trust-key provisioning.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_ISOLATED_BUILD_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){
    throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'
}
$projectRoot=Join-Path $root 'ops/windows-sealer-service'
$project=Join-Path $projectRoot 'ConsoleMcp.Sealer.Service.csproj'
$pin=Get-Content -LiteralPath (Join-Path $projectRoot 'global.json') -Raw | ConvertFrom-Json
if($pin.sdk.version -cne '10.0.403' -or $pin.sdk.rollForward -cne 'latestPatch'){
    throw 'RELEASE_SEAL_BUILD_PIN_INVALID'
}
$uri='https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.403/dotnet-sdk-10.0.403-win-x64.zip'
$expected='7a114c318fa7f1d9822991b534b2814d0e78386ceda816b371f5141acefe741d87ccb606ede06cadac8f9ac5070e32b708a67bbd1619ff5e5a7858a27874ef48'
$cache=Join-Path $root '.isolated-sdk'
$zip=Join-Path $cache 'sdk.zip'
$sdkRoot=Join-Path $cache 'sdk'
if(-not (Test-Path -LiteralPath $cache)){[IO.Directory]::CreateDirectory($cache) | Out-Null}
foreach($path in @($cache,$zip,$sdkRoot)){
    if(Test-Path -LiteralPath $path){
        if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
            throw 'RELEASE_SEAL_BUILD_REPARSE_POINT'
        }
    }
}
if(-not (Test-Path -LiteralPath $zip -PathType Leaf)){
    Invoke-WebRequest -Uri $uri -OutFile $zip -MaximumRedirection 3 -ErrorAction Stop
}
$actual=(Get-FileHash -LiteralPath $zip -Algorithm SHA512).Hash.ToLowerInvariant()
if($actual -cne $expected){throw 'RELEASE_SEAL_SDK_SHA512_MISMATCH'}
if(-not (Test-Path -LiteralPath $sdkRoot -PathType Container)){
    [IO.Directory]::CreateDirectory($sdkRoot) | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $sdkRoot -Force
}
$exe=Join-Path $sdkRoot 'dotnet.exe'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'RELEASE_SEAL_SDK_ENTRY_MISSING'}
$priorRoot=$env:DOTNET_ROOT
$priorPath=$env:PATH
$priorTelemetry=$env:DOTNET_CLI_TELEMETRY_OPTOUT
$env:DOTNET_ROOT=$sdkRoot
$env:PATH=$sdkRoot+';'+$priorPath
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
try {
    Push-Location $projectRoot
    try {
        $version=& $exe --version
        if($LASTEXITCODE -ne 0 -or [string]$version -cne '10.0.403'){
            throw 'RELEASE_SEAL_ISOLATED_SDK_VERSION_MISMATCH'
        }
        & $exe build $project --configuration Release --nologo --verbosity quiet
        if($LASTEXITCODE -ne 0){throw 'RELEASE_SEAL_ISOLATED_BUILD_FAILED'}
    } finally {Pop-Location}
} finally {
    $env:DOTNET_ROOT=$priorRoot
    $env:PATH=$priorPath
    $env:DOTNET_CLI_TELEMETRY_OPTOUT=$priorTelemetry
}
$publish=Join-Path $projectRoot 'bin/Release/net10.0-windows'
$out=Join-Path $publish 'ConsoleMcp.Sealer.Service.exe'
if(-not (Test-Path -LiteralPath $out -PathType Leaf)){throw 'RELEASE_SEAL_ISOLATED_EXE_MISSING'}
@{status='RELEASE_SEAL_ISOLATED_BUILD_PASS';sdk='10.0.403';sdk_sha512=$expected;
  executable_sha256=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant();
  output=$out;framework_dependent=$true;service_installed=$false;production_changed=$false} | ConvertTo-Json -Compress
