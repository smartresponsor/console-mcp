# Read-only process observation for an isolated broker fixture.
# Process existence alone is NOT authenticated evidence of stop/start/health.
function Test-RuntimeReleaseIsolatedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][int]$ProcessId,
        [Parameter(Mandatory=$true)][datetimeoffset]$CreatedAt,
        [Parameter(Mandatory=$true)][string]$Executable
    )
    if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($Executable)) { return $false }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if ($process.HasExited) { return $false }
        $actualStart = [datetimeoffset]$process.StartTime.ToUniversalTime()
        if ([math]::Abs(($actualStart - $CreatedAt.ToUniversalTime()).TotalSeconds) -gt 1) { return $false }
        $actualPath = [string]$process.Path
        if ([string]::IsNullOrWhiteSpace($actualPath)) { return $false }
        return [string]::Equals(
            [System.IO.Path]::GetFullPath($actualPath),
            [System.IO.Path]::GetFullPath($Executable),
            [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}
