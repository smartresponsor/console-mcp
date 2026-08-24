param(
    [string] $Root = (Resolve-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '..\..')).Path,
    [int] $MaxDepth = 4,
    [ValidateRange(1,8)][int] $ThrottleLimit = 4,
    [switch] $NoHistory,
    [switch] $IncludeLocalOnly
)
$ErrorActionPreference = 'Stop'
$scan = Join-Path $PSScriptRoot 'security-scan.ps1'
$excluded = @('.git','node_modules','vendor','.venv','var','dist','build','.idea','.console-mcp','_quarantine','.security-rollout')
function Find-GitRepositories([string] $Start, [int] $DepthLimit) {
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ path=$Start; depth=0 })
    $found = @()
    while ($queue.Count -gt 0) {
        $entry = $queue.Dequeue()
        $path = [string]$entry.path
        if (Test-Path -LiteralPath (Join-Path $path '.git')) {
            $found += $path
        }
        if ([int]$entry.depth -ge $DepthLimit) { continue }
        foreach ($child in @(Get-ChildItem -LiteralPath $path -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($excluded -contains $child.Name) { continue }
            $queue.Enqueue([pscustomobject]@{ path=$child.FullName; depth=([int]$entry.depth + 1) })
        }
    }
    $found
}
$discovered = @(Find-GitRepositories -Start $Root -DepthLimit $MaxDepth | Sort-Object -Unique)
$seen = @{}
$repos = @()
foreach ($repo in $discovered) {
    $origin = (& git -C $repo remote get-url origin 2>$null)
    if ($LASTEXITCODE -eq 0 -and $origin) {
        $normalizedOrigin = (($origin.Trim() -replace '\.git$','') -replace '^git@github\.com:','https://github.com/').ToLowerInvariant()
        if ($normalizedOrigin -notmatch '^https://github\.com/smartresponsor/' -and -not $IncludeLocalOnly) { continue }
        $key = $normalizedOrigin
    } elseif ($IncludeLocalOnly) {
        $key = "path:$($repo.ToLowerInvariant())"
    } else {
        continue
    }
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $repo
    $repos += $repo
}
$results = @($repos | ForEach-Object -Parallel {
    $repo = $_
    $scanPath = $using:scan
    $noHistory = $using:NoHistory
    $started = Get-Date
    $scanArgs = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$scanPath,'-Repository',$repo)
    if ($noHistory) { $scanArgs += '-NoHistory' }
    $output = & pwsh @scanArgs 2>&1
    $exit = $LASTEXITCODE
    [pscustomobject]@{
        repository = $repo
        ok = ($exit -eq 0)
        exit_code = $exit
        duration_ms = [int]((Get-Date) - $started).TotalMilliseconds
        output = (($output | Select-Object -Last 30) -join "`n")
    }
} -ThrottleLimit $ThrottleLimit)
$failed = @($results | Where-Object { -not $_.ok })
[ordered]@{
    ok = ($failed.Count -eq 0)
    root = $Root
    repository_count = $results.Count
    failed_count = $failed.Count
    results = @($results | Sort-Object repository)
} | ConvertTo-Json -Depth 7
if ($failed.Count -gt 0) { exit 1 }
