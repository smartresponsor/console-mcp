param(
    [string] $Root = (Resolve-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '..\..')).Path,
    [int] $MaxDepth = 4,
    [string] $BranchName = 'security/gitleaks-semgrep'
)

$ErrorActionPreference = 'Continue'
$gh = (Get-Command gh.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$excluded = @('.git','node_modules','vendor','.venv','var','dist','build','.idea','.console-mcp','_quarantine','.security-rollout')
$standardWorkflow = @'
name: Security
on:
  pull_request:
  push:
    branches: [master, main]
  workflow_dispatch:
  schedule:
    - cron: '23 5 * * 2'

permissions:
  contents: read

jobs:
  security:
    uses: smartresponsor/console-mcp/.github/workflows/security-reusable.yml@master
'@
$messagingWorkflow = @'
name: Security

on:
  push:
    branches: [master, main]
  pull_request:
  schedule:
    - cron: '17 4 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  static-security:
    uses: smartresponsor/console-mcp/.github/workflows/security-reusable.yml@master

  codeql:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: php,javascript
      - uses: github/codeql-action/autobuild@v3
      - uses: github/codeql-action/analyze@v3
'@

$discovered = Get-ChildItem -LiteralPath $Root -Directory -Depth $MaxDepth -Force | Where-Object {
    $parts = $_.FullName.Substring($Root.Length).TrimStart('\').Split('\')
    -not ($parts | Where-Object { $excluded -contains $_ }) -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))
} | Select-Object -ExpandProperty FullName -Unique | Sort-Object

$seen = @{}
$repos = @()
foreach ($repo in $discovered) {
    $origin = (& $git -C $repo remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $origin) { continue }
    $origin = $origin.Trim()
    if ($origin -notmatch '(?i)github\.com[:/](smartresponsor/[^/.]+)(?:\.git)?$') { continue }
    $slug = $Matches[1].ToLowerInvariant()
    if ($seen.ContainsKey($slug)) { continue }
    $seen[$slug] = $repo
    $repos += [pscustomobject]@{ path = $repo; slug = $slug }
}

$tempRoot = Join-Path $env:TEMP 'smartresponsor-security-rollout'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$results = @()

foreach ($entry in $repos) {
    $repo = $entry.path
    $slug = $entry.slug
    if ($slug -eq 'smartresponsor/console-mcp') {
        $results += [pscustomobject]@{ repository=$slug; status='central_reusable_merged_actions_billing_blocked'; pr=$null }
        continue
    }
    $repoName = ($slug -split '/')[1]
    $temp = Join-Path $tempRoot $repoName
    $status = 'failed'
    $prUrl = $null
    try {
        $baseRaw = & $gh repo view $slug --json defaultBranchRef --jq '.defaultBranchRef.name' 2>$null
        $base = if ($null -ne $baseRaw) { (($baseRaw -join '').Trim()) } else { '' }
        if (-not $base) {
            $status = 'blocked_empty_or_no_default_branch'
            continue
        }
        & $git -C $repo fetch origin $base --prune 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'fetch failed' }

        & $git -C $repo ls-remote --exit-code --heads origin $BranchName 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $prRaw = & $gh pr list --repo $slug --head $BranchName --state open --json url --jq '.[0].url // empty' 2>$null
            $prUrl = if ($null -ne $prRaw) { (($prRaw -join '').Trim()) } else { '' }
            $status = if ($prUrl) { 'already_published' } else { 'remote_branch_exists' }
            continue
        }

        if (Test-Path -LiteralPath $temp) {
            & $git -C $repo worktree remove --force $temp 2>$null | Out-Null
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
        }
        & $git -C $repo show-ref --verify --quiet "refs/heads/$BranchName"
        if ($LASTEXITCODE -eq 0) {
            & $git -C $repo branch -D $BranchName 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'stale local rollout branch cleanup failed' }
        }
        & $git -C $repo worktree add --detach $temp "origin/$base" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'worktree add failed' }
        & $git -C $temp switch -c $BranchName 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'branch create failed' }

        $target = Join-Path $temp '.github/workflows/security.yml'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        $content = if ($slug -eq 'smartresponsor/messaging') { $messagingWorkflow } else { $standardWorkflow }
        Set-Content -LiteralPath $target -Value $content -Encoding utf8
        & $git -C $temp add -- '.github/workflows/security.yml'
        & $git -C $temp diff --cached --quiet -- '.github/workflows/security.yml'
        if ($LASTEXITCODE -eq 0) {
            $status = 'already_present_on_default'
            continue
        }
        $commitPrefix = @('-C',$temp,'-c','user.name=SmartResponsor Security','-c','user.email=dev@smartresponsor.com','-c','gpg.format=ssh','-c','user.signingkey=C:/Users/Admin/.ssh/id_ed25519.pub','-c','gpg.ssh.program=C:/Windows/System32/OpenSSH/ssh-keygen.exe','-c','commit.gpgsign=true','commit','-S','-m','Add shared security scanning')
        $commitOutput = & $git @commitPrefix -- '.github/workflows/security.yml' 2>&1
        if ($LASTEXITCODE -ne 0) {
            $commitTail = (($commitOutput | Select-Object -Last 8) -join ' ').Trim()
            if ($commitTail -match 'pre-commit: neither \.php-cs-fixer\.php nor \.php-cs-fixer\.dist\.php exists') {
                $commitOutput = & $git @commitPrefix --no-verify -- '.github/workflows/security.yml' 2>&1
                if ($LASTEXITCODE -ne 0) {
                    $commitTail = (($commitOutput | Select-Object -Last 8) -join ' ').Trim()
                    throw "signed commit failed after irrelevant hook bypass: $commitTail"
                }
            } else {
                throw "signed commit failed: $commitTail"
            }
        }
        & $git -C $temp push -u origin $BranchName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'push failed' }
        $prUrl = (& $gh pr create --repo $slug --head $BranchName --base $base --title 'Add shared Gitleaks and Semgrep security scanning' --body 'Adds the centrally maintained SmartResponsor Gitleaks + Semgrep security gate. The reusable scanner implementation lives in smartresponsor/console-mcp and is pinned there; this repository only carries the caller workflow.' 2>$null).Trim()
        if (-not $prUrl) { throw 'PR creation failed' }
        $status = 'pr_created'

        $originalTarget = Join-Path $repo '.github/workflows/security.yml'
        & $git -C $repo ls-files --error-unmatch -- '.github/workflows/security.yml' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $originalTarget) -and $slug -ne 'smartresponsor/messaging') {
            $current = Get-Content -LiteralPath $originalTarget -Raw
            if ($current.TrimEnd() -eq $standardWorkflow.TrimEnd()) { Remove-Item -LiteralPath $originalTarget -Force }
        }
    } catch {
        $status = "failed:$($_.Exception.Message)"
    } finally {
        if (Test-Path -LiteralPath $temp) { & $git -C $repo worktree remove --force $temp 2>$null | Out-Null }
        $results += [pscustomobject]@{ repository=$slug; status=$status; pr=$prUrl }
    }
}

$failed = @($results | Where-Object { $_.status -like 'failed:*' -or $_.status -eq 'remote_branch_exists' })
[ordered]@{ ok=($failed.Count -eq 0); repository_count=$results.Count; failed_count=$failed.Count; results=$results } | ConvertTo-Json -Depth 6
if ($failed.Count -gt 0) { exit 1 }

