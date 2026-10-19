param([switch]$ManifestOnly, [string]$Candidate, [switch]$Build)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = if ($Candidate) { (Resolve-Path -LiteralPath $Candidate).Path } else { Join-Path $root ('tmp/visible-runtime-' + (git -C $root rev-parse --short HEAD)) }
$stagingRoot = Join-Path $root 'tmp'
if (-not $stage.StartsWith((Join-Path $stagingRoot 'visible-runtime-'))) { throw 'Candidate outside permitted staging namespace' }
if ($ManifestOnly -and $Build) { throw 'Choose either manifest verification or build' }
if ($ManifestOnly) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist/service/visible-browser-session.js'))) { throw 'Compiled candidate missing' }
    $files = @()
    $files += Get-ChildItem -LiteralPath (Join-Path $stage 'dist') -Recurse -File -Filter '*.js' | Sort-Object FullName
    $files += Get-Item -LiteralPath (Join-Path $root 'ops/ubuntu/script/install-visible-runtime.sh')
    $files += Get-ChildItem -LiteralPath (Join-Path $root 'ops/ubuntu/systemd') -Recurse -File | Sort-Object FullName
    $files += Get-Item -LiteralPath (Join-Path $root 'ops/ubuntu/config/console-mcp-desktop.tmpfiles')
    $files += Get-ChildItem -LiteralPath (Join-Path $root 'ops/ubuntu/script') -File -Filter '*.py' | Sort-Object FullName
    $lines = foreach ($file in $files) {
        $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        $relative = if ($file.FullName.StartsWith($stage + '/')) { $file.FullName.Substring($stage.Length + 1) } else { $file.FullName }
        "$sha  $relative"
    }
    [System.IO.File]::WriteAllLines((Join-Path $stage 'reviewed.sha256'), [string[]]$lines)
    Push-Location $stage
    try { & sha256sum --check --quiet reviewed.sha256; if ($LASTEXITCODE -ne 0) { throw 'Manifest verification failed' } }
    finally { Pop-Location }
    @{ok=$true;stage=$stage;entries=$lines.Count;manifest=(Join-Path $stage 'reviewed.sha256')} | ConvertTo-Json -Compress
    return
}
if ($ManifestOnly) { throw 'Manifest generation returned unexpectedly' }
if (Test-Path -LiteralPath $stage) { throw 'Preserving existing stage' }
New-Item -ItemType Directory -Path $stage | Out-Null
$archive = Join-Path $stage 'base.tar'
& git -C $root archive --format=tar -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
& tar -xf $archive -C $stage
if ($LASTEXITCODE -ne 0) { throw 'Extract failed' }
Remove-Item -LiteralPath $archive
New-Item -ItemType SymbolicLink -Path (Join-Path $stage 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $stage 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$artifact = Join-Path $stage 'dist/service/visible-browser-session.js'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
@{ok=$true;stage=$stage;artifact=$artifact;sha256=$hash} | ConvertTo-Json -Compress
