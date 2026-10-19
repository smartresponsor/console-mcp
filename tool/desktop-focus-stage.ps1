param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root 'tmp/desktop-focus-20261018'
if (Test-Path -LiteralPath $stage) { throw 'Staging directory already exists; preserve existing state' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$tarFile = Join-Path $stage 'base.tar'
& git -C $root archive --format=tar -o $tarFile HEAD
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
& tar -xf $tarFile -C $stage
if ($LASTEXITCODE -ne 0) { throw 'tar extract failed' }
Remove-Item -LiteralPath $tarFile
Copy-Item -LiteralPath (Join-Path $root 'src/cli/desktop-focus-cli.ts') -Destination (Join-Path $stage 'src/cli/desktop-focus-cli.ts')
Copy-Item -LiteralPath (Join-Path $root 'ops/ubuntu/script/native-window-activate.py') -Destination (Join-Path $stage 'ops/ubuntu/script/native-window-activate.py')
Copy-Item -LiteralPath (Join-Path $root 'ops/ubuntu/script/desktop-session-agent.py') -Destination (Join-Path $stage 'ops/ubuntu/script/desktop-session-agent.py')
New-Item -ItemType SymbolicLink -Path (Join-Path $stage 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Staged typecheck failed' }
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Staged build failed' }
& python3 -m py_compile (Join-Path $stage 'ops/ubuntu/script/native-window-activate.py') (Join-Path $stage 'ops/ubuntu/script/desktop-session-agent.py')
if ($LASTEXITCODE -ne 0) { throw 'Python syntax failed' }
$artifact = Join-Path $stage 'dist/cli/desktop-focus-cli.js'
if (!(Test-Path -LiteralPath $artifact)) { throw 'CLI not built' }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
Write-Output (ConvertTo-Json -Compress @{ok=$true;stage=$stage;cli=$artifact;sha256=$hash;consoleRestartRequired=$false})
