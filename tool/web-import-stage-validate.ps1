$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$stage=Join-Path $root 'tmp/visible-runtime-import-20261016'
if(-not (Test-Path -LiteralPath $stage -PathType Container)){throw 'Stage missing'}
if(-not (Test-Path -LiteralPath (Join-Path $stage 'node_modules'))){& ln -s (Join-Path $root 'node_modules') (Join-Path $stage 'node_modules'); if($LASTEXITCODE -ne 0){throw 'Dependencies symlink failed'}}
& pwsh -NoProfile -File (Join-Path $root 'tool/visible-runtime-validation.ps1') -Candidate $stage
if($LASTEXITCODE -ne 0){throw 'Candidate validation failed'}
Write-Output ('IMPORT_BUILT='+(Test-Path -LiteralPath (Join-Path $stage 'dist/tool/web-artifact-import.js') -PathType Leaf))
