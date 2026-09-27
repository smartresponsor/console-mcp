$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $root 'var\run\watchdog-cadence-state.json'
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { throw "Missing cadence state: $stateFile" }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -Depth 40
$now = [datetimeoffset]::UtcNow
$names = @(
    'runtime',
    'local_auth',
    'browser',
    'public_tunnel',
    'visual_gallery',
    'task_integrity',
    'chatgpt_background_target_hygiene',
    'environment',
    'browser_housekeeping',
    'engine_target_reaper',
    'runtime_stability',
    'build_fingerprint'
)
$rows = foreach ($name in $names) {
    $lane = $null
    try { $lane = $state.lanes.$name } catch { $lane = $null }
    if (-not $lane) {
        [pscustomobject]@{ name=$name; present=$false; interval_seconds=$null; completed_at=$null; age_seconds=$null; overdue_seconds=$null; status=$null; ok=$null }
        continue
    }
    $completedAt = $null
    try {
        $value = $lane.completed_at
        $completedAt = if ($value -is [datetimeoffset]) { $value.ToUniversalTime() } elseif ($value -is [datetime]) { [datetimeoffset]::new($value.ToUniversalTime()) } else { [datetimeoffset]::Parse([string]$value).ToUniversalTime() }
    } catch { $completedAt = $null }
    $interval = [int]$lane.interval_seconds
    $age = if ($completedAt) { [math]::Round(($now - $completedAt).TotalSeconds, 1) } else { $null }
    $overdue = if ($null -ne $age) { [math]::Round($age - $interval, 1) } else { $null }
    [pscustomobject]@{
        name=$name
        present=$true
        interval_seconds=$interval
        completed_at=if($completedAt){$completedAt.ToString('o')}else{$null}
        age_seconds=$age
        overdue_seconds=$overdue
        status=[string]$lane.status
        ok=[bool]$lane.ok
    }
}
[pscustomobject]@{
    ok=$true
    status='WATCHDOG_CADENCE_LANE_SUMMARY'
    sampled_at=$now.ToString('o')
    lanes=@($rows)
    repair_not_before=$state.repair_not_before
    repair_deferral_reason=$state.repair_deferral_reason
} | ConvertTo-Json -Depth 10
