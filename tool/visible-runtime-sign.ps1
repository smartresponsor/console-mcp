param([string]$Message = 'feat(ubuntu): manage authenticated visible desktop browser runtime')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& git -C $root diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff invalid' }
& git -C $root commit -S -m $Message
if ($LASTEXITCODE -ne 0) { throw 'Signed commit failed' }
& git -C $root log -1 --format='%H %G? %s'
