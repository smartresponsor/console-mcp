$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node "$root/node_modules/typescript/bin/tsc" -p "$root/tsconfig.json" --noEmit
if ($LASTEXITCODE -ne 0) { throw 'TypeScript typecheck failed' }
$tool = Get-Command wmctrl -ErrorAction SilentlyContinue
if ($tool) { 'wmctrl: PRESENT' } else { 'wmctrl: MISSING' }
$xdotool = Get-Command xdotool -ErrorAction SilentlyContinue
if ($xdotool) { 'xdotool: PRESENT' } else { 'xdotool: MISSING' }
