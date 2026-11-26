param([string]$ShareExisting,[string]$ManifestSha256)
$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if ($ShareExisting) {
 & /usr/bin/node (Join-Path $PSScriptRoot 'm7-cache-prepare.mjs') --share-existing $ShareExisting $ManifestSha256
} else {
 & /usr/bin/node (Join-Path $PSScriptRoot 'm7-cache-prepare.mjs')
}
exit $LASTEXITCODE
