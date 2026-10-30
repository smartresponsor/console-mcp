param(
    [string]$ProductionRoot = 'D:\PhpstormProjects\www\mcp\console-mcp',
    [Parameter(Mandatory)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
$runtimeEvents = @(foreach ($line in [IO.File]::ReadLines((Join-Path $ProductionRoot 'var/log/console-mcp-runtime-events.ndjson'))) {
    try {
        $record = $line | ConvertFrom-Json
        if ($record.pid -in @(26476,41864)) {
            $record | Select-Object timestamp,event,pid,ppid,buildFingerprint
        }
    } catch { }
})
$watchdog = @(foreach ($line in [IO.File]::ReadLines((Join-Path $ProductionRoot 'var/log/console-mcp-watchdog.log'))) {
    if ($line -notmatch '"at": "2026-10-28T00:0') { continue }
    try {
        $record = $line | ConvertFrom-Json
        [pscustomobject]@{ at=$record.at; status=$record.status; error=$record.error; actions=@($record.actions | Select-Object action,reason,status) }
    } catch { }
})
$start = [datetime]'2026-10-27T23:45:00'
$end = [datetime]'2026-10-28T00:05:00'
$windowsEvents = @(foreach ($log in @('System','Application','Microsoft-Windows-TaskScheduler/Operational','OpenSSH/Operational')) {
    try {
        Get-WinEvent -FilterHashtable @{LogName=$log;StartTime=$start;EndTime=$end} -MaxEvents 100 -ErrorAction Stop |
            Where-Object { $_.ProviderName -match 'Resource-Exhaustion|Application Error|Service Control|TaskScheduler|OpenSSH' } |
            Select-Object TimeCreated,ProviderName,Id,Message
    } catch { [pscustomobject]@{ log=$log; unavailableOrEmpty=$true; reason=$_.FullyQualifiedErrorId } }
})
$processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe'" | Where-Object {
    $_.ProcessId -eq 41864 -or $_.CommandLine -match 'dev-console.ps1 watchdog-loop-run'
} | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    [pscustomobject]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; created=$_.CreationDate; session=$_.SessionId; executable=$_.ExecutablePath; owner=($owner.Domain+'\'+$owner.User) }
})
$listeners = @(Get-NetTCPConnection -LocalPort 3333,3334,3335 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess)
$services = @(Get-CimInstance Win32_Service | Where-Object {$_.Name -in @('sshd','Tailscale')} | Select-Object Name,State,ProcessId)
$loop = Get-Content (Join-Path $ProductionRoot 'var/run/console-mcp-watchdog-loop-state.json') -Raw | ConvertFrom-Json
$report = [ordered]@{
    schema=1; capturedAt=(Get-Date).ToUniversalTime().ToString('o'); machine=$env:COMPUTERNAME
    productionChanged=$false; runtimeEvents=$runtimeEvents; watchdogEvents=$watchdog; windowsEvents=$windowsEvents
    processes=$processes; listeners=$listeners; services=$services; watchdogStatus=$loop.status
    watchdogCount=@($processes | Where-Object {$_.pid -ne 41864}).Count
    interactiveSessions=@(& quser 2>&1 | ForEach-Object { [string]$_ })
    crossSessionHwndGate='BLOCKED_SECOND_INTERACTIVE_SESSION_UNAVAILABLE'
    diagnosis='System virtual-memory exhaustion is confirmed by Event 2004; watchdog startup failed with pagefile-too-small and later recovered. Exact termination of PID 26476 is not logged. SSH causation is not established.'
}
$directory = Split-Path -Parent $OutputFile
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputFile -Encoding utf8
[pscustomobject]@{ok=$true;output=$OutputFile;watchdogStatus=$loop.status;runtimePids=@($listeners.OwningProcess|Select-Object -Unique)} | ConvertTo-Json -Compress
