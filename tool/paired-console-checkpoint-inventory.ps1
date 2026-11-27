$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if ($root -ne '/home/alex/smartresponse/mcp/.worktrees/console-chat-prompt-screenshot-20261126') { throw 'WRONG_ROOT' }
$env:GIT_CONFIG_NOSYSTEM='1'
$env:GIT_CONFIG_GLOBAL='/dev/null'
$env:GIT_OPTIONAL_LOCKS='0'
$env:GIT_NO_REPLACE_OBJECTS='1'
$env:GIT_TERMINAL_PROMPT='0'
function GitRead {
    & /usr/bin/git --no-optional-locks -c "safe.directory=$root" -c core.fsmonitor=false -c diff.autoRefreshIndex=false -C $root @args
    if ($LASTEXITCODE -ne 0) { throw 'GIT_READ_FAILED' }
}
if ((GitRead rev-parse HEAD) -ne '4c1b6fe57f33e2f4c8735c600f0ae3114cfdad7a') { throw 'HEAD_DRIFT' }
if ((GitRead branch --show-current) -ne 'feature/chat-prompt-screenshot') { throw 'BRANCH_DRIFT' }
GitRead diff --check
GitRead diff --cached --check
$staged=@(GitRead diff --cached --name-only)
if ($staged.Count -ne 0) { throw 'UNEXPECTED_STAGING' }
$files=@(@(GitRead diff --name-only) + @(GitRead ls-files --others --exclude-standard) | Sort-Object -Unique)
$rows=@(foreach ($f in $files) {
    if ($f -notmatch '^(docs|ops/ubuntu|src|tool)/[A-Za-z0-9_./-]+$') { throw "UNEXPECTED_FILE $f" }
    $p=Join-Path $root $f
    $i=Get-Item -LiteralPath $p
    if ($i.LinkType -or $i.PSIsContainer) { throw "UNEXPECTED_FILE_TYPE $f" }
    @{path=$f;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
})
@{status='PAIRED_CONSOLE_CHECKPOINT_INVENTORY';head='4c1b6fe57f33e2f4c8735c600f0ae3114cfdad7a';branch='feature/chat-prompt-screenshot';files=$rows} | ConvertTo-Json -Depth 4 -Compress
