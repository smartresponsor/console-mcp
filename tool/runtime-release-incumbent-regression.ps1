# Isolated incumbent snapshot regression; no process is stopped or started.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-transaction.ps1')
$live = [pscustomobject]@{ running=$true; port_open=$true; port_conflict=$false; pid=$PID }
$snapshot = Get-RuntimeReleaseIncumbentSnapshot -ProcessState $live
if (-not $snapshot -or $snapshot.pid -ne $PID -or [string]::IsNullOrWhiteSpace($snapshot.started_at)) {
    throw 'Live incumbent identity capture failed.'
}
if (-not (Test-RuntimeReleaseIncumbentContinuity -Snapshot $snapshot)) { throw 'Live process continuity failed.' }
$wrongStart = [pscustomobject]@{ pid=$PID; started_at=[datetimeoffset]::UtcNow.AddYears(-1).ToString('o') }
if (Test-RuntimeReleaseIncumbentContinuity -Snapshot $wrongStart) { throw 'PID reuse accepted.' }
if (Test-RuntimeReleaseIncumbentContinuity -Snapshot ([pscustomobject]@{ pid=2147483647; started_at=$snapshot.started_at })) {
    throw 'Missing incumbent accepted.'
}
$journal = [pscustomobject]@{ incumbent=$snapshot }
$roundTrip = $journal | ConvertTo-Json -Depth 8 | ConvertFrom-Json
if (-not (Test-RuntimeReleaseJournalIncumbent -Journal $roundTrip)) {
    throw "Serialized incumbent continuity failed: original=$($snapshot.started_at) parsed=$($roundTrip.incumbent.started_at) type=$($roundTrip.incumbent.started_at.GetType().FullName)"
}
$roundTrip.incumbent.started_at = [datetimeoffset]::UtcNow.AddYears(-1).ToString('o')
if (Test-RuntimeReleaseJournalIncumbent -Journal $roundTrip) {
    throw 'Serialized stale incumbent accepted.'
}
if (-not (Test-RuntimeReleaseJournalIncumbent -Journal $journal)) { throw 'Journal incumbent rejected.' }
$journal.incumbent = $wrongStart
if (Test-RuntimeReleaseJournalIncumbent -Journal $journal) { throw 'Stale journal incumbent accepted.' }
if (Test-RuntimeReleaseJournalIncumbent -Journal ([pscustomobject]@{})) { throw 'Missing journal incumbent accepted.' }
foreach ($case in @(
    [pscustomobject]@{ running=$false; port_open=$true; port_conflict=$false; pid=$PID },
    [pscustomobject]@{ running=$true; port_open=$false; port_conflict=$false; pid=$PID },
    [pscustomobject]@{ running=$true; port_open=$true; port_conflict=$true; pid=$PID },
    [pscustomobject]@{ running=$true; port_open=$true; port_conflict=$false; pid=0 },
    [pscustomobject]@{ running=$true; port_open=$true; port_conflict=$false; pid=2147483647 }
)) {
    if (Get-RuntimeReleaseIncumbentSnapshot -ProcessState $case) { throw 'Invalid incumbent accepted.' }
}
Write-Output 'RELEASE_INCUMBENT_SNAPSHOT_PASS'
