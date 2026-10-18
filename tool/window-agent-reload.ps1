$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$script=Join-Path $root 'ops/ubuntu/script/reload-desktop-agent-window-ops.sh'
$pkexec=Get-Command pkexec -ErrorAction SilentlyContinue
if(!$pkexec){throw 'PKEXEC_UNAVAILABLE'}
& $pkexec.Source /bin/bash $script
if($LASTEXITCODE -ne 0){throw ('PKEXEC_EXIT_'+$LASTEXITCODE)}
