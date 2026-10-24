# systemd owns the Linux runtime; never bootstrap a Windows watchdog here.
function Get-LinuxConsoleRuntime {
    $properties = @(& systemctl show console-mcp.service --property=ActiveState,MainPID,WorkingDirectory --no-pager 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect console-mcp.service' }
    $unit = @{}
    foreach ($line in $properties) {
        if ([string]$line -match '^([^=]+)=(.*)$') { $unit[$Matches[1]] = $Matches[2] }
    }
    $servicePid = 0
    [void][int]::TryParse([string]$unit.MainPID, [ref]$servicePid)
    $process = if ($servicePid -gt 0) { Get-ConsoleProcess -ProcessId $servicePid } else { $null }
    $entrypoint = Join-Path $Root 'dist/index.js'
    $identity = [bool]($process -and $unit.WorkingDirectory -eq $Root -and
        $process.CommandLine -match [regex]::Escape($entrypoint))
    $statusCode = 0
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3333/mcp' -SkipHttpErrorCheck -TimeoutSec 5
        $statusCode = [int]$response.StatusCode
    } catch { }
    return [pscustomobject]@{
        running = [bool]($unit.ActiveState -eq 'active' -and $identity)
        pid = $servicePid
        identity_confirmed = $identity
        endpoint_status = $statusCode
        endpoint_responding = [bool]($statusCode -in @(200, 400, 401, 405, 406))
    }
}

function Invoke-LinuxConsoleRestart {
    param([switch]$CheckOnly)
    try { $before = Get-LinuxConsoleRuntime } catch {
        return [pscustomobject]@{ ok = $false; status = 'RESTART_PREFLIGHT_BLOCKED'; runtime_mutated = $false; error = $_.Exception.Message }
    }
    if (-not $before.running -or -not $before.endpoint_responding) {
        return [pscustomobject]@{ ok = $false; status = 'RESTART_PREFLIGHT_BLOCKED'; runtime_mutated = $false; runtime = $before }
    }
    if ($CheckOnly) {
        return [pscustomobject]@{ ok = $true; status = 'RESTART_PREFLIGHT_READY'; runtime_mutated = $false; runtime = $before; recovery_owner = 'systemd' }
    }
    # Authorization is delegated to systemd/polkit. Never prompt, sudo, or kill a process.
    $output = @(& systemctl --no-ask-password restart console-mcp.service 2>&1)
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ ok = $false; status = 'SYSTEMD_RESTART_REJECTED'; runtime_mutated = $null; runtime = $before; error = ($output -join "`n") }
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        try { $after = Get-LinuxConsoleRuntime } catch { $after = $null }
        if ($after -and $after.running -and $after.endpoint_responding -and $after.pid -ne $before.pid) {
            return [pscustomobject]@{ ok = $true; status = 'RESTART_COMPLETED_SCHEMA_PENDING'; runtime_mutated = $true; before = $before; runtime = $after; recovery_owner = 'systemd' }
        }
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ ok = $false; status = 'RESTART_VERIFICATION_FAILED'; runtime_mutated = $true; before = $before; runtime = $after }
}
