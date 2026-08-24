param(
    [string] $Root = (Resolve-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '..\..')).Path,
    [int] $MaxDepth = 4,
    [ValidateRange(1,8)][int] $ThrottleLimit = 4
)
$ErrorActionPreference = 'Stop'
$scan = Join-Path $PSScriptRoot 'security-scan.ps1'
$excluded = @('.git','node_modules','vendor','.venv','var','dist','build','.idea','.console-mcp','_quarantine')
$discovered = Get-ChildItem -LiteralPath $Root -Directory -Depth $MaxDepth -Force |
    Where-Object {
        $path = $_.FullName
        $parts = $path.Substring($Root.Length).TrimStart('\').Split('\')
        -not ($parts | Where-Object { $excluded -contains $_ }) -and
        (Test-Path -LiteralPath (Join-Path $path '.git'))
    } |
    Select-Object -ExpandProperty FullName -Unique |
    Sort-Object
if (Test-Path -LiteralPath (Join-Path $Root '.git')) { $discovered = @($Root) + @($discovered) }
$seen = @{}
$repos = @()
foreach ($repo in $discovered) {
    $origin = (& git -C $repo remote get-url origin 2>$null)
    $key = if ($LASTEXITCODE -eq 0 -and $origin) { (($origin.Trim() -replace '\.git$','') -replace '^git@github\.com:','https://github.com/').ToLowerInvariant() } else { "path:$($repo.ToLowerInvariant())" }
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $repo
    $repos += $repo
}
$results = @($repos | ForEach-Object -Parallel {
    $repo = $_
    $scanPath = $using:scan
    $started = Get-Date
    $output = & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scanPath -Repository $repo 2>&1
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
