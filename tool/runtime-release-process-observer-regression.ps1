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
'RUNTIME_RELEASE_PROCESS_OBSERVER_REGRESSION_PASS'
