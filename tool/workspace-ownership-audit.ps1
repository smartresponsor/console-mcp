$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Resolve-Path '.').Path 'ops/ubuntu/script/workspace-ownership.sh'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Workspace ownership script missing' }
& /usr/bin/bash $scriptPath audit
if ($LASTEXITCODE -ne 0) { throw "Workspace ownership audit failed: $LASTEXITCODE" }
