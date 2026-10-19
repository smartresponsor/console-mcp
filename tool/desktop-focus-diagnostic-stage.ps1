$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root 'tmp/desktop-focus-diagnostics-20261018'
if (Test-Path -LiteralPath $stage) { throw 'Staging already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
& git -C $root archive --format=tar HEAD | tar -xf - -C $stage
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
Copy-Item -LiteralPath (Join-Path $root 'src/service/visible-browser-session.ts') -Destination (Join-Path $stage 'src/service/visible-browser-session.ts')
New-Item -ItemType SymbolicLink -Path (Join-Path $stage 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$artifact = Join-Path $stage 'dist/service/visible-browser-session.js'
if (!(Test-Path $artifact)) { throw 'Missing verified build' }
$hash = (Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLowerInvariant()
Write-Output (ConvertTo-Json -Compress @{ok=$true;stage=$stage;artifact=$artifact;sha256=$hash})
