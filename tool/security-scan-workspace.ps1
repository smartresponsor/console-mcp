param(
    [string] $Root = (Resolve-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '..\..')).Path,
    [int] $MaxDepth = 4,
    [ValidateRange(1,16)][int] $ThrottleLimit = 8,
    [ValidateRange(1,6)][int] $SemgrepThrottleLimit = 3,
    [switch] $IncludeLocalOnly,
    [switch] $SkipGitleaks,
    [switch] $SkipSemgrep
)
$ErrorActionPreference = 'Stop'
$gitleaks = (Get-Command gitleaks -ErrorAction Stop).Source
$semgrep = (Get-Command semgrep -ErrorAction Stop).Source
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
function Get-Batches([object[]] $Items, [int] $Size) {
    for ($offset = 0; $offset -lt $Items.Count; $offset += $Size) {
        $last = [Math]::Min($offset + $Size - 1, $Items.Count - 1)
        ,@($Items[$offset..$last])
    }
}

Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{ stage='discovery'; discovered_git_roots=$discovered.Count; repository_count=$repos.Count; include_local_only=[bool]$IncludeLocalOnly } | ConvertTo-Json -Compress))

$gitleaksResults = @()
if (-not $SkipGitleaks) {
    $gitleaksBatches = @(Get-Batches -Items $repos -Size $ThrottleLimit)
    for ($batchIndex = 0; $batchIndex -lt $gitleaksBatches.Count; $batchIndex++) {
        $batch = @($gitleaksBatches[$batchIndex])
        $batchResults = @($batch | ForEach-Object -Parallel {
            $repo = $_
            $exe = $using:gitleaks
            $started = Get-Date
            $output = & $exe git --redact --verbose --no-banner --no-color $repo 2>&1
            $exit = $LASTEXITCODE
            [pscustomobject]@{
                repository = $repo
                ok = ($exit -eq 0)
                exit_code = $exit
                duration_ms = [int]((Get-Date) - $started).TotalMilliseconds
                output = (($output | Select-Object -Last 40) -join "`n")
            }
        } -ThrottleLimit $ThrottleLimit)
        $gitleaksResults += $batchResults
        $batchFailures = @($batchResults | Where-Object { -not $_.ok })
        Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{
            stage='gitleaks'
            batch=($batchIndex + 1)
            batch_count=$gitleaksBatches.Count
            completed=$gitleaksResults.Count
            total=$repos.Count
            failed=$batchFailures.Count
            failed_repositories=@($batchFailures | ForEach-Object { $_.repository })
        } | ConvertTo-Json -Compress))
    }
} else {
    Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{ stage='gitleaks'; skipped=$true } | ConvertTo-Json -Compress))
}

$semgrepBaseArgs = @('scan','--config','p/security-audit','--metrics=off','--error','--jobs','1','--max-memory','1024','--timeout','30','--exclude','.git','--exclude','.venv','--exclude','vendor','--exclude','node_modules','--exclude','var','--exclude','dist','--exclude','build','--exclude','_quarantine','--exclude','.security-rollout')
$semgrepResults = @()
if (-not $SkipSemgrep) {
    Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{ stage='semgrep'; status='started'; repository_count=$repos.Count; throttle=$SemgrepThrottleLimit; process_timeout_seconds=50 } | ConvertTo-Json -Compress))
    $semgrepResults = @($repos | ForEach-Object -Parallel {
        $repo = $_
        $exe = $using:semgrep
        $baseArgs = $using:semgrepBaseArgs
        $started = Get-Date
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $exe
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        foreach ($arg in @($baseArgs + @($repo))) { [void]$psi.ArgumentList.Add([string]$arg) }
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $psi
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $completed = $process.WaitForExit(50000)
        $timedOut = -not $completed
        if ($timedOut) {
            try { $process.Kill($true) } catch {}
            try { [void]$process.WaitForExit(5000) } catch {}
        }
        $stdout = try { $stdoutTask.GetAwaiter().GetResult() } catch { $_.Exception.Message }
        $stderr = try { $stderrTask.GetAwaiter().GetResult() } catch { $_.Exception.Message }
        $exit = if ($timedOut) { 124 } else { $process.ExitCode }
        $combined = (($stdout, $stderr | Where-Object { $_ }) -join "`n")
        [pscustomobject]@{
            repository = $repo
            ok = ($exit -eq 0)
            timed_out = $timedOut
            exit_code = $exit
            duration_ms = [int]((Get-Date) - $started).TotalMilliseconds
            output = (($combined -split "`r?`n" | Select-Object -Last 180) -join "`n")
        }
    } -ThrottleLimit $SemgrepThrottleLimit)
    $completedCount = 0
    foreach ($entry in @($semgrepResults | Sort-Object repository)) {
        $completedCount++
        Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{
            stage='semgrep'
            completed=$completedCount
            total=$repos.Count
            repository=$entry.repository
            ok=$entry.ok
            timed_out=$entry.timed_out
            duration_ms=$entry.duration_ms
        } | ConvertTo-Json -Compress))
    }
} else {
    Write-Output ("SECURITY_SCAN_PROGRESS " + ([ordered]@{ stage='semgrep'; skipped=$true } | ConvertTo-Json -Compress))
}

$failedLeaks = @($gitleaksResults | Where-Object { -not $_.ok })
$failedSemgrep = @($semgrepResults | Where-Object { -not $_.ok })
$result = [ordered]@{
    ok = ($failedLeaks.Count -eq 0 -and $failedSemgrep.Count -eq 0)
    root = $Root
    repository_count = $repos.Count
    gitleaks_failed_count = $failedLeaks.Count
    semgrep_failed_batch_count = $failedSemgrep.Count
    gitleaks_failures = @($failedLeaks | Sort-Object repository)
    semgrep_failures = $failedSemgrep
}
Write-Output ("SECURITY_SCAN_RESULT " + ($result | ConvertTo-Json -Depth 7 -Compress))
if (-not $result.ok) { exit 1 }

