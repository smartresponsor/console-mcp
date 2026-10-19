$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$stage=Join-Path $root 'tmp/desktop-focus-x11-proof-20261018'
if (Test-Path $stage) { throw 'Stage exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
$archive=Join-Path $stage 'base.tar'
& git -C $root archive --format=tar -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
& tar -xf $archive -C $stage
if ($LASTEXITCODE -ne 0) { throw 'Extraction failed' }
Remove-Item $archive
Copy-Item (Join-Path $root 'src/service/visible-browser-session.ts') (Join-Path $stage 'src/service/visible-browser-session.ts')
New-Item -ItemType SymbolicLink -Path (Join-Path $stage 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$artifact=Join-Path $stage 'dist/service/visible-browser-session.js'
$sha=(Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLowerInvariant()
@{ok=$true;artifact=$artifact;sha256=$sha}|ConvertTo-Json -Compress
