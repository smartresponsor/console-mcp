param(
    [Parameter(Mandatory)][string]$OutputFile,
    [ValidateRange(1,30)][int]$Samples = 3,
    [ValidateRange(250,10000)][int]$IntervalMs = 1000
)
$ErrorActionPreference = 'Stop'
$history = [Collections.Generic.List[object]]::new()
for ($sample = 0; $sample -lt $Samples; $sample++) {
    $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='codebase-memory-mcp.exe' OR Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe'" | Where-Object {
        $_.Name -eq 'codebase-memory-mcp.exe' -or $_.CommandLine -match 'dev-console.ps1 watchdog-loop-run|console-mcp[\\/].*index.js|code-memory-bounded-gateway.mjs'
    } | ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=$_.CreationDate;session=$_.SessionId;name=$_.Name;privateBytes=$process.PrivateMemorySize64;workingSetBytes=$process.WorkingSet64;handles=$process.HandleCount;threads=$process.Threads.Count;cpuSeconds=$process.CPU} }
    })
    $history.Add([pscustomobject]@{capturedAt=(Get-Date).ToUniversalTime().ToString('o');committedBytes=$memory.CommittedBytes;commitLimitBytes=$memory.CommitLimit;availablePhysicalBytes=$memory.AvailableBytes;processes=$processes})
    if ($sample + 1 -lt $Samples) { Start-Sleep -Milliseconds $IntervalMs }
}
$report = [ordered]@{schema=1;readOnly=$true;samples=$history;peakCommittedBytes=($history|Measure-Object committedBytes -Maximum).Maximum;minimumAvailablePhysicalBytes=($history|Measure-Object availablePhysicalBytes -Minimum).Minimum}
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputFile) -Force | Out-Null
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputFile -Encoding utf8
[pscustomobject]@{ok=$true;samples=$Samples;output=$OutputFile} | ConvertTo-Json -Compress
