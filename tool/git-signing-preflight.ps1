param([switch]$Configure, [switch]$PushValidated, [switch]$SyncTracking)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$keys = @('user.name','user.email','user.signingkey','gpg.format','gpg.ssh.program','commit.gpgsign')
$configs = [ordered]@{}
foreach ($key in $keys) {
    $value = & git -C $root config --get $key 2>$null
    $configs[$key] = if ($LASTEXITCODE -eq 0) { [string]$value } else { $null }
}
$recent = & git -C $root log -1 --format='%an <%ae> | signing-status=%G?'
$homePath = [Environment]::GetFolderPath('UserProfile')
$publicKeys = @()
foreach ($pub in @(Get-ChildItem -LiteralPath (Join-Path $homePath '.ssh') -Filter '*.pub' -File -ErrorAction SilentlyContinue)) {
    $fingerprint = & ssh-keygen -lf $pub.FullName 2>$null
    if ($LASTEXITCODE -eq 0) { $publicKeys += @{ name = $pub.Name; fingerprint = [string]$fingerprint } }
}
$private = Join-Path $homePath '.ssh/id_ed25519'
$sign = [ordered]@{ private_key_present = (Test-Path -LiteralPath $private); signing_works = $false; verify_works = $false; error = $null }
if ($sign.private_key_present) {
    $probeDir = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-signing-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
        $payload = Join-Path $probeDir 'probe.txt'
        $allowed = Join-Path $probeDir 'allowed_signers'
        Set-Content -LiteralPath $payload -Value 'git signing preflight' -NoNewline
        $pub = Join-Path $homePath '.ssh/id_ed25519.pub'
        Set-Content -LiteralPath $allowed -Value ('office@smartresponsor.com ' + (Get-Content -LiteralPath $pub -Raw).Trim())
        $null = & ssh-keygen -Y sign -f $private -n git $payload 2>$null
        $sign.signing_works = ($LASTEXITCODE -eq 0)
        if ($sign.signing_works) {
            $signature = $payload + '.sig'
            $null = & bash -c 'ssh-keygen -Y verify -f "$1" -I office@smartresponsor.com -n git -s "$2" < "$3"' -- $allowed $signature $payload 2>$null
            $sign.verify_works = ($LASTEXITCODE -eq 0)
        }
    } catch { $sign.error = $_.Exception.GetType().Name }
    finally { Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($Configure) {
    if (-not ($sign.signing_works -and $sign.verify_works)) { throw 'Verified signing key required' }
    if ($recent -notmatch '^Oleksandr Tishchenko <office@smartresponsor\.com>') { throw 'Existing repository author does not match expected authorized identity' }
    $public = Join-Path $homePath '.ssh/id_ed25519.pub'
    $gitConfig = [ordered]@{
        'user.name' = 'Oleksandr Tishchenko'
        'user.email' = 'office@smartresponsor.com'
        'gpg.format' = 'ssh'
        'gpg.ssh.program' = 'ssh-keygen'
        'user.signingkey' = $public
        'commit.gpgsign' = 'true'
    }
    foreach ($entry in $gitConfig.GetEnumerator()) {
        & git -C $root config --local $entry.Key $entry.Value
        if ($LASTEXITCODE -ne 0) { throw "Unable to configure Git $($entry.Key)" }
    }
    $gitMetaPath = (& git -C $root rev-parse --git-path cmcp-allowed-signers).Trim()
    if (-not [IO.Path]::IsPathRooted($gitMetaPath)) { $gitMetaPath = Join-Path $root $gitMetaPath }
    Set-Content -LiteralPath $gitMetaPath -Value ('office@smartresponsor.com ' + (Get-Content -LiteralPath $public -Raw).Trim())
    & git -C $root config --local gpg.ssh.allowedSignersFile $gitMetaPath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to register signature verifier' }
    $gitConfig['gpg.ssh.allowedSignersFile'] = $gitMetaPath
    $configs = $gitConfig
}
$sshRemote = [ordered]@{ available = $false; remote_head = $null; matches_local_tracking = $false }
try {
    $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=7'
    $remote = & git -C $root ls-remote git@github.com:smartresponsor/console-mcp.git refs/heads/fix/ubuntu-workspace-writes 2>$null
    if ($LASTEXITCODE -eq 0 -and $remote -match '^([0-9a-f]{40})') {
        $sshRemote.available = $true
        $sshRemote.remote_head = $Matches[1]
        $tracking = & git -C $root rev-parse refs/remotes/origin/fix/ubuntu-workspace-writes 2>$null
        $sshRemote.matches_local_tracking = ($LASTEXITCODE -eq 0 -and $tracking -eq $sshRemote.remote_head)
    }
} catch {} finally { Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
if ($PushValidated) {
    $branch = (& git -C $root branch --show-current).Trim()
    $head = (& git -C $root rev-parse HEAD).Trim()
    if ($branch -ne 'fix/ubuntu-workspace-writes') { throw 'Unexpected push branch' }
    if (-not ($sshRemote.available -and $sshRemote.matches_local_tracking)) { throw 'Remote changed or SSH credentials unavailable; refusing push' }
    & git -C $root merge-base --is-ancestor $sshRemote.remote_head $head
    if ($LASTEXITCODE -ne 0) { throw 'Push is not fast-forward' }
    try {
        $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=7'
        $env:GIT_CONFIG_COUNT = '1'
        $env:GIT_CONFIG_KEY_0 = 'remote.origin.url'
        $env:GIT_CONFIG_VALUE_0 = 'git@github.com:smartresponsor/console-mcp.git'
        & git -C $root push git@github.com:smartresponsor/console-mcp.git 'HEAD:refs/heads/fix/ubuntu-workspace-writes'
        if ($LASTEXITCODE -ne 0) { throw 'SSH push failed' }
        $after = & git -C $root ls-remote git@github.com:smartresponsor/console-mcp.git refs/heads/fix/ubuntu-workspace-writes
        if ($LASTEXITCODE -ne 0 -or $after -notmatch ('^' + $head + '\s')) { throw 'Remote push SHA verification failed' }
        $sshRemote['verified_pushed_head'] = $head
    } finally {
        foreach ($key in @('GIT_SSH_COMMAND','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
    }
}
if ($SyncTracking) {
    $head = (& git -C $root rev-parse HEAD).Trim()
    if (-not $sshRemote.available -or $sshRemote.remote_head -ne $head) { throw 'Remote HEAD must equal local HEAD before tracking sync' }
    try {
        $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=7'
        & git -C $root fetch git@github.com:smartresponsor/console-mcp.git 'refs/heads/fix/ubuntu-workspace-writes:refs/remotes/origin/fix/ubuntu-workspace-writes'
        if ($LASTEXITCODE -ne 0) { throw 'Tracking fetch failed' }
        $sshRemote['tracking_synchronized'] = $true
    } finally { Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
}
$remotePushUrl = (& git -C $root remote get-url --push origin 2>$null)
$pushurlConfig = (& git -C $root config --get remote.origin.pushurl 2>$null)
$hooksPath = (& git -C $root config --get core.hooksPath 2>$null)
[pscustomobject]@{ remote_push_url = [string]$remotePushUrl; pushurl_override = [string]$pushurlConfig; hooks_path = [string]$hooksPath; ssh_remote = $sshRemote; uid = [Environment]::UserName; home = $homePath; git_config = $configs; last_commit = [string]$recent; public_signing_keys = $publicKeys; ssh_agent_present = [bool]$env:SSH_AUTH_SOCK; signing_probe = $sign; requires_private_key_disclosure = $false } | ConvertTo-Json -Depth 6
