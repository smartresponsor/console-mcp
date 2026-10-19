param([switch]$Locked)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node "$root/tool/visible-runtime-acceptance.mjs" $(if ($Locked) { '--locked' } else { '--inspect' })
if ($LASTEXITCODE -ne 0) { throw 'Visible runtime acceptance failed' }
