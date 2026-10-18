$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'ops/ubuntu/script/deploy-desktop-focus.sh'
$pkexec = Get-Command pkexec -ErrorAction SilentlyContinue
if (!$pkexec) { throw 'pkexec unavailable; interactive admin authorization required' }
& $pkexec.Source /bin/bash $script
if ($LASTEXITCODE -ne 0) { throw ('Privileged deployment rejected, exit=' + $LASTEXITCODE) }
