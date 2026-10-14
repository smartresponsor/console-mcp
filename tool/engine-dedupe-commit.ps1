$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$names = @(& git -C $repo diff --cached --name-only)
if ($LASTEXITCODE -ne 0 -or $names.Count -ne 1 -or $names[0] -ne 'src/engine/engine-core.ts') { throw 'Index contains unexpected paths' }
$diff = (& git -C $repo diff --cached -- src/engine/engine-core.ts) -join "`n"
if (($diff -match 'management_state|setEngineManagementState|workerTick') -or (([regex]::Matches($diff, '(?m)^@@ ')).Count -ne 5)) { throw 'Index is not the expected hash-only patch' }
& git -C $repo diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged patch whitespace check failed' }
& git -C $repo commit -S -m 'fix(engine): scope active task reuse by execution specification'
if ($LASTEXITCODE -ne 0) { throw 'Signed commit failed' }
& git -C $repo log -1 --format='%h %s'
