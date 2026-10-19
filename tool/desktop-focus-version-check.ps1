$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$live=Join-Path $root 'dist/service/visible-browser-session.js'
$stage=Join-Path $root 'tmp/desktop-focus-x11-window-id-fix-20261018/dist/service/visible-browser-session.js'
$hash=(Get-FileHash -Algorithm SHA256 $live).Hash.ToLowerInvariant()
$staged=(Get-FileHash -Algorithm SHA256 $stage).Hash.ToLowerInvariant()
@{ installedHash=$hash;stageHash=$staged;matchesStaged=($hash -eq $staged);parserFixed=([IO.File]::ReadAllText($live).Contains('ACTIVE_WINDOW[^\n]*?')) } | ConvertTo-Json -Compress
