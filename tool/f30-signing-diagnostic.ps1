$ErrorActionPreference = "Stop"
$repo = "/home/alex/smartresponse/mcp/.worktrees/console-looping-f30-review"
Write-Output "SERVICE_CONTEXT"
& /usr/bin/id -un
Write-Output "GIT_SIGNING_CONFIG"
& git -c "safe.directory=$repo" -C $repo config --show-origin --show-scope --get-regexp '^(gpg\.format|gpg\.ssh\.program|user\.signingkey|commit\.gpgsign|user\.name|user\.email)$'
Write-Output "PUBLIC_KEY_PATHS_ONLY"
foreach ($path in @("/home/alex/.ssh/id_ed25519_signing.pub","/home/alex/.ssh/id_ed25519.pub","/var/lib/console-mcp/.ssh/id_ed25519_signing.pub")) {
 $metadata = & /usr/bin/stat -c '%n OWNER=%U MODE=%a SIZE=%s' -- $path 2>$null
 if ($LASTEXITCODE -eq 0) { Write-Output $metadata } else { Write-Output "MISSING_OR_INACCESSIBLE=$path" }
}
Write-Output "GIT_INDEX_STATUS"
& git -c "safe.directory=$repo" -C $repo status --short
