# Read-only .NET package-restore diagnosis. Only isolated Windows fixture.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'RELEASE_SEAL_NUGET_WINDOWS_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'}
$sdk=Join-Path $root '.isolated-sdk/sdk/dotnet.exe'
if(-not (Test-Path -LiteralPath $sdk)){throw 'RELEASE_SEAL_SDK_MISSING'}
$project=Join-Path $root 'ops/windows-sealer-service'
Push-Location $project
try {
    $sources=@(& $sdk nuget list source --format short 2>&1 | ForEach-Object { [string]$_ })
    $sourceExit=$LASTEXITCODE
} finally { Pop-Location }
$cache=Join-Path $root '.isolated-sdk/sdk/packs'
$packs=@()
if(Test-Path -LiteralPath $cache){
 $packs=@(Get-ChildItem -LiteralPath $cache -Directory | ForEach-Object {$_.Name})
}
@{status='RELEASE_SEAL_NUGET_DIAGNOSTIC';nuget_sources=$sources;nuget_exit=$sourceExit;installed_packs=$packs;production_changed=$false} | ConvertTo-Json -Depth 4 -Compress
