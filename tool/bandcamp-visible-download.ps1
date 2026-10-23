param(
  [Parameter(Mandatory=$true)][string]$Destination,
  [ValidateSet('mp3-320','mp3-v0','flac')][string]$Format='mp3-320',
  [Parameter(Mandatory=$true)][string]$AlbumUrl,
  [ValidateSet('download','inspect')][string]$Mode='download'
)
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'bandcamp-visible-download.mjs') $Destination $Format $AlbumUrl $Mode
if($LASTEXITCODE -ne 0){throw ('Bandcamp download failed: '+$LASTEXITCODE)}
