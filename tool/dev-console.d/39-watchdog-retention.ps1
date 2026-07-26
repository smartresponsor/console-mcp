$RetentionMarkerFile = Join-Path $RunDir 'console-mcp-retention-last-run.json'
$RetentionTargets = @(
    [pscustomobject]@{ Path = (Join-Path $Root 'var/transcript'); MaxAgeDays = 7 },
    [pscustomobject]@{ Path = (Join-Path $Root 'var/browser'); MaxAgeDays = 7 },
    [pscustomobject]@{ Path = (Join-Path $Root 'var/stack'); MaxAgeDays = 14 }
)

function Invoke-VarRetentionIfDue {
    param([int]$IntervalHours = 6)

    $due = $true
    if (Test-Path -LiteralPath $RetentionMarkerFile) {
        try {
            $marker = Get-Content -LiteralPath $RetentionMarkerFile -Raw | ConvertFrom-Json
            $lastRun = [datetime]::Parse([string]$marker.at)
            if (((Get-Date).ToUniversalTime() - $lastRun.ToUniversalTime()).TotalHours -lt $IntervalHours) {
                $due = $false
            }
        } catch {
            $due = $true
        }
    }

    if (-not $due) {
        return $null
    }

    $results = foreach ($target in $RetentionTargets) {
        $targetPath = $target.Path
        $maxAgeDays = $target.MaxAgeDays
        $deleted = 0
        $kept = 0
        $bytesFreed = [int64]0
        if (Test-Path -LiteralPath $targetPath -PathType Container) {
            $cutoffUtc = (Get-Date).ToUniversalTime().AddDays(-1 * $maxAgeDays)
            Get-ChildItem -LiteralPath $targetPath -File -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.LastWriteTimeUtc -lt $cutoffUtc) {
                    $bytesFreed += $_.Length
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                    $deleted++
                } else {
                    $kept++
                }
            }
        }
        [pscustomobject]@{ path = $targetPath; max_age_days = $maxAgeDays; deleted = $deleted; kept = $kept; bytes_freed = $bytesFreed }
    }

    $summary = [pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('o'); results = @($results) }
    $summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $RetentionMarkerFile -Encoding utf8
    return $summary
}
