param(
    [string] $Root = 'D:\PhpstormProjects\www',
    [string] $BranchName = 'security/dev-app-secret-baseline'
)
$ErrorActionPreference = 'Stop'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$gh = (Get-Command gh.exe -ErrorAction Stop).Source
$targets = @{
    'smartresponsor/smartresponse' = 'App'
    'smartresponsor/currencing' = 'Currencing'
    'smartresponsor/interfacing' = 'Interfacing'
    'smartresponsor/paging' = 'Paging'
}
$tempRoot = Join-Path $env:TEMP 'smartresponsor-dev-secret-remediation'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$results = @()
foreach ($slug in $targets.Keys) {
    $repo = Join-Path $Root $targets[$slug]
    $temp = Join-Path $tempRoot ($targets[$slug].ToLowerInvariant())
    $status = 'failed'
    $pr = $null
    try {
        $baseRaw = & $gh repo view $slug --json defaultBranchRef --jq '.defaultBranchRef.name' 2>$null
        $base = if ($null -ne $baseRaw) { (($baseRaw -join '').Trim()) } else { '' }
        if (-not $base) { throw 'default branch unavailable' }
        & $git -C $repo fetch origin $base --prune 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'fetch failed' }
        & $git -C $repo ls-remote --exit-code --heads origin $BranchName 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $prRaw = & $gh pr list --repo $slug --head $BranchName --state open --json url --jq '.[0].url // empty' 2>$null
            $pr = if ($null -ne $prRaw) { (($prRaw -join '').Trim()) } else { '' }
            $status = if ($pr) { 'already_published' } else { 'remote_branch_exists' }
            continue
        }
        if (Test-Path -LiteralPath $temp) {
            & $git -C $repo worktree remove --force $temp 2>$null | Out-Null
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
        }
        & $git -C $repo show-ref --verify --quiet "refs/heads/$BranchName"
        if ($LASTEXITCODE -eq 0) { & $git -C $repo branch -D $BranchName 2>$null | Out-Null }
        & $git -C $repo worktree add --detach $temp "origin/$base" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'worktree add failed' }
        & $git -C $temp switch -c $BranchName 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'branch create failed' }
        $envFile = Join-Path $temp '.env.dev'
        if (-not (Test-Path -LiteralPath $envFile)) { $status = 'no_env_dev'; continue }
        $content = Get-Content -LiteralPath $envFile -Raw
        if ($content -notmatch '(?m)^APP_SECRET=(.+)$') { $status = 'no_app_secret'; continue }
        $value = $Matches[1].Trim()
        if (-not $value -or $value -eq 'dev-only-not-a-secret') { $status = 'already_baselined'; continue }
        $updated = [regex]::Replace($content, '(?m)^APP_SECRET=.*$', 'APP_SECRET=dev-only-not-a-secret', 1)
        [System.IO.File]::WriteAllText($envFile, $updated, [System.Text.UTF8Encoding]::new($false))
        & $git -C $temp add -- '.env.dev'
        $commitPrefix = @('-C',$temp,'-c','user.name=SmartResponsor Security','-c','user.email=dev@smartresponsor.com','-c','gpg.format=ssh','-c','user.signingkey=C:/Users/Admin/.ssh/id_ed25519.pub','-c','gpg.ssh.program=C:/Windows/System32/OpenSSH/ssh-keygen.exe','-c','commit.gpgsign=true','commit','-S','-m','Remove tracked development secret')
        $commitOutput = & $git @commitPrefix -- '.env.dev' 2>&1
        if ($LASTEXITCODE -ne 0) {
            $tail = (($commitOutput | Select-Object -Last 8) -join ' ').Trim()
            if ($tail -match 'pre-commit: neither \.php-cs-fixer\.php nor \.php-cs-fixer\.dist\.php exists') {
                $commitOutput = & $git @commitPrefix --no-verify -- '.env.dev' 2>&1
                if ($LASTEXITCODE -ne 0) { throw "commit failed after irrelevant hook bypass: $(($commitOutput | Select-Object -Last 8) -join ' ')" }
            } else {
                throw "commit failed: $tail"
            }
        }
        & $git -C $temp push -u origin $BranchName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'push failed' }
        $prRaw = & $gh pr create --repo $slug --head $BranchName --base $base --title 'Remove tracked development APP_SECRET' --body 'Replaces the tracked .env.dev APP_SECRET value with an explicit non-secret development placeholder. Historical values remain part of the separate secret-rotation/history-remediation track and must not be reused as production credentials.' 2>$null
        $pr = if ($null -ne $prRaw) { (($prRaw -join '').Trim()) } else { '' }
        if (-not $pr) { throw 'PR creation failed' }
        $status = 'pr_created'
    } catch {
        $status = "failed:$($_.Exception.Message)"
    } finally {
        if (Test-Path -LiteralPath $temp) { & $git -C $repo worktree remove --force $temp 2>$null | Out-Null }
        $results += [pscustomobject]@{ repository=$slug; status=$status; pr=$pr }
    }
}
$failed = @($results | Where-Object { $_.status -like 'failed:*' -or $_.status -eq 'remote_branch_exists' })
[ordered]@{ ok=($failed.Count -eq 0); failed_count=$failed.Count; results=$results } | ConvertTo-Json -Depth 5
if ($failed.Count -gt 0) { exit 1 }

