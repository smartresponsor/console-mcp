$ErrorActionPreference = "Stop"
$root = "/home/alex/smartresponse/mcp/.worktrees/console-looping-f30-review"
Write-Output "F30_WORKTREE_OWNER"
& /usr/bin/stat -c 'owner=%U group=%G mode=%a' $root
Write-Output "F30_COMMIT_SCRIPT_SYNTAX"
& /usr/bin/bash -n "/home/alex/smartresponse/looping-m2-pr202-ubuntu-local/tool/f30_commit_as_alex.sh"
& /usr/bin/bash -n "/home/alex/smartresponse/looping-m2-pr202-ubuntu-local/tool/f30_signing_setup_as_alex.sh"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "F30_COMMIT_SCRIPT_SYNTAX_PASS"
Write-Output "F30_GIT_EXACT_SHA"
& git -c "safe.directory=$root" -C $root rev-parse HEAD
Write-Output "F30_GIT_STATUS"
& git -c "safe.directory=$root" -C $root status --short
Write-Output "F30_GIT_DIFF_CHECK"
& git -c "safe.directory=$root" -C $root diff --check
Write-Output "F30_GROUPS"
& /usr/bin/getent group smartresponse
& /usr/bin/id alex
& /usr/bin/id console-mcp
Write-Output "F30_RUNTIME_CLIENT_EXISTS"
$client="/home/alex/.local/bin/tunnel-client"
if (Test-Path $client) {
  Write-Output "F30_CLIENT_PRESENT"
  Write-Output "F30_CLIENT_HELP"
  & $client runtimes --help 2>&1 | Select-Object -First 70
  Write-Output "F30_CLIENT_CONNECT_HELP"
  & $client runtimes connect --help 2>&1 | Select-Object -First 100
} else {
  Write-Output "F30_CLIENT_MISSING_FOR_SERVICE_USER"
}
