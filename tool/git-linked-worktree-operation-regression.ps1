$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
& node tool/git-linked-worktree-operation-regression.mjs
if($LASTEXITCODE -ne 0){throw 'Git linked worktree guard fixture failed'}
