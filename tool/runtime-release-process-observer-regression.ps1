$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-process-observer.ps1')
$self = Get-Process -Id $PID -ErrorAction Stop
$created = [datetimeoffset]$self.StartTime.ToUniversalTime()
$path = [string]$self.Path
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Fixture process executable unavailable.' }
if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created -Executable $path)) {
    throw 'Live fixture identity was rejected.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created.AddMinutes(-5) -Executable $path) {
    throw 'Stale process identity was accepted.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $PID -CreatedAt $created -Executable ($path + '.other')) {
    throw 'Executable mismatch was accepted.'
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId 2147483647 -CreatedAt $created -Executable $path) {
    throw 'Missing process was accepted.'
}
# The only process stopped here is a child spawned by this regression.
$child = $null
try {
    $child = Start-Process -FilePath $path -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20') -PassThru -WindowStyle Hidden
    $child.Refresh()
    $childCreated = [datetimeoffset]$child.StartTime.ToUniversalTime()
    if (-not (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path)) {
        throw 'Isolated child was not observed as running.'
    }
    if (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated.AddMinutes(-2) -Executable $path) {
        throw 'Child PID reuse guard failed.'
    }
} finally {
    if ($null -ne $child) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(10000) | Out-Null }
    }
}
if (Test-RuntimeReleaseIsolatedProcess -ProcessId $child.Id -CreatedAt $childCreated -Executable $path) {
    throw 'Stopped isolated child was still observed as running.'
}
'RUNTIME_RELEASE_PROCESS_OBSERVER_REGRESSION_PASS'
