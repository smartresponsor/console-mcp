$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gitfile = Join-Path $root '.git'
if ((Get-Item -LiteralPath $gitfile -Force).LinkType) { throw 'Refusing symlinked .git' }
$gitline = (Get-Content -LiteralPath $gitfile -Raw).Trim()
if ($gitline -notmatch '^gitdir: (.+)$') { throw 'Expected linked worktree gitfile' }
$gitdir = if ([System.IO.Path]::IsPathRooted($Matches[1])) { [System.IO.Path]::GetFullPath($Matches[1]) } else { [System.IO.Path]::GetFullPath((Join-Path $root $Matches[1])) }
$backlink = (Get-Content -LiteralPath (Join-Path $gitdir 'gitdir') -Raw).Trim()
$backlinkPath = if ([System.IO.Path]::IsPathRooted($backlink)) { [System.IO.Path]::GetFullPath($backlink) } else { [System.IO.Path]::GetFullPath((Join-Path $gitdir $backlink)) }
if ($backlinkPath -ne $gitfile) { throw 'Invalid worktree backlink' }
$safe = "safe.directory=$root"
& git -c $safe rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'HEAD inspection failed' }
& git -c $safe status --short
if ($LASTEXITCODE -ne 0) { throw 'status failed' }
& git -c $safe diff --check
if ($LASTEXITCODE -ne 0) { throw 'diff --check failed' }
& git -c $safe diff --stat
if ($LASTEXITCODE -ne 0) { throw 'diff --stat failed' }
& git -c $safe diff -- package.json src/tool/git-inspection.ts tool/git-inspection-fail-closed-regression.mjs tool/runtime-deployment-preflight-regression.ps1
if ($LASTEXITCODE -ne 0) { throw 'diff failed' }
Write-Output 'GIT_LOCAL_TRUST_READ_ONLY_REVIEW_PASS'
