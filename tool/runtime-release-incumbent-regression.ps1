# Isolated incumbent snapshot regression; no process is stopped or started.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-transaction.ps1')
$live = [pscustomobject]@{ running=$true; port_open=$true; port_conflict=$false; pid=$PID }
$snapshot = Get-RuntimeReleaseIncumbentSnapshot -ProcessState $live
if (-not $snapshot -or $snapshot.pid -ne $PID -or [string]::IsNullOrWhiteSpace($snapshot.started_at)) {
    throw 'Live incumbent identity capture failed.'
}
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
