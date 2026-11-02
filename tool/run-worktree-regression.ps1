$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'git-worktree-regression.mjs')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
