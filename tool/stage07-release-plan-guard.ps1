$ErrorActionPreference='Continue'
$source='/home/alex/smartresponse/mcp/.worktrees/.worktrees/.worktrees/stage06-release-extended-20261118'
$sha='28b527e47f0a3dbe939c480738e03aca75bf8c46'
$python=Join-Path $source 'ops/ubuntu/script/prepare-console-release.py'
Write-Output 'STAGE07_RELEASE_PLAN_ONLY_BEGIN'
Write-Output ('SOURCE_SHA='+ (& git -c "safe.directory=$source" -C $source rev-parse HEAD))
Write-Output ('SOURCE_TRACKED_DIRTY='+@(& git -c "safe.directory=$source" -C $source status --porcelain --untracked-files=no).Count)
& /usr/bin/python3 -I $python --source $source --sha $sha 2>&1
Write-Output ('READONLY_PLAN_EXIT='+$LASTEXITCODE)
if($LASTEXITCODE -eq 0){Write-Output 'STAGE07_MASTER_GUARD_UNEXPECTED_PASS';exit 21}
Write-Output 'STAGE07_MASTER_PROVENANCE_GUARD_BLOCKED_AS_EXPECTED'
