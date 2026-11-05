$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Split-Path $root -Leaf) -cnotmatch '^sealing-acl-fixture-[0-9]{8}$'){throw 'RELEASE_SEAL_ISOLATED_WORKSPACE_REQUIRED'}
$path=Join-Path $root '.isolated-sdk/sdk.zip'
$exists=Test-Path -LiteralPath $path -PathType Leaf
@{status='RELEASE_SEAL_SDK_CACHE_READONLY';download_exists=$exists;
  bytes=if($exists){(Get-Item -LiteralPath $path).Length}else{0};
  production_changed=$false} | ConvertTo-Json -Compress
