$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Resolve-Path '.').Path 'ops/ubuntu/script/workspace-ownership.sh'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Workspace ownership script missing' }
& /usr/bin/sudo -n /usr/bin/bash $scriptPath apply
if ($LASTEXITCODE -ne 0) { throw "Noninteractive authorized apply unavailable: $LASTEXITCODE" }
