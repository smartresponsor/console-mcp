$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$git=@('-c',"safe.directory=$root")
$candidate=(& git @git rev-parse HEAD).Trim()
$base='df90d4706bf3c476ddcf9ef6ba09f6be039d8fec'
Write-Output ('CANDIDATE_SHA='+$candidate)
Write-Output ('CANDIDATE_TREE='+(& git @git rev-parse 'HEAD^{tree}'))
Write-Output ('COMMIT_SIGNATURE='+((& git @git log -1 --format='%G?' HEAD).Trim()))
Write-Output ('WORKTREE_STATUS_COUNT='+@(& git @git status --porcelain=v1).Count)
Write-Output ('UPSTREAM_MASTER_SHA='+$base)
& git @git merge-base --is-ancestor $base HEAD
Write-Output ('CANDIDATE_INCLUDES_MASTER='+($LASTEXITCODE -eq 0))
& git @git merge-base --is-ancestor HEAD $base
Write-Output ('CANDIDATE_REACHABLE_FROM_MASTER='+($LASTEXITCODE -eq 0))
Write-Output ('LOCAL_ORIGIN_MASTER='+(& git @git rev-parse refs/remotes/origin/master))
Write-Output ('CANDIDATE_TRACKED_FILES='+@(& git @git ls-files).Count)
Write-Output 'SERVICE_READONLY:'
$units=@('console-mcp.service','repo-mcp.service','openai-repo-tunnel.service')
foreach($u in $units){
 $props=(& systemctl show $u --property=LoadState,ActiveState,SubState,UnitFileState,Restart,RestartUSec,NRestarts,MainPID --no-pager 2>&1 | Out-String).Trim()
 Write-Output ('UNIT='+$u)
 Write-Output $props
}
Write-Output 'RELEASE_SOURCE_GUARD:'
$script=Join-Path $root 'ops/ubuntu/script/prepare-console-release.py'
$content=[IO.File]::ReadAllText($script)
Write-Output ('MASTER_ANCESTOR_REQUIRED='+$content.Contains("git(source, 'merge-base', '--is-ancestor', args.sha, 'origin/master')"))
Write-Output ('EXACT_CLEAN_SOURCE_REQUIRED='+$content.Contains("git(source, 'status', '--porcelain', '--untracked-files=no')"))
Write-Output 'STAGE07_AUDIT_COMPLETED'
