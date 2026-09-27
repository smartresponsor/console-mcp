$ErrorActionPreference = 'Stop'

$mcpRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$profile = [System.IO.Path]::GetFullPath((Join-Path $mcpRoot 'browser\profile'))
$portFlag = '--remote-debugging-port=9223'

$processes = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop)
$visibleByPid = @{}
foreach ($process in @(Get-Process msedge -ErrorAction SilentlyContinue)) {
    $visibleByPid[[int]$process.Id] = [bool]($process.MainWindowHandle -ne 0)
}

$managed = @($processes | Where-Object {
    $commandLine = [string]$_.CommandLine
    $commandLine.Contains($portFlag) -or $commandLine.Contains($profile)
})

$managedByPid = @{}
foreach ($process in $managed) { $managedByPid[[int]$process.ProcessId] = $process }

$listenerPid = $null
try {
    $connection = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($connection) { $listenerPid = [int]$connection.OwningProcess }
} catch {
    $listenerPid = $null
}

function Get-ManagedRootPid {
    param([Parameter(Mandatory = $true)]$Process)
    $current = $Process
    $seen = @{}
    while ($current) {
        $processId = [int]$current.ProcessId
        if ($seen.ContainsKey($processId)) { break }
        $seen[$processId] = $true
        $parentPid = [int]$current.ParentProcessId
        if (-not $managedByPid.ContainsKey($parentPid)) { return $processId }
        $current = $managedByPid[$parentPid]
    }
    return [int]$Process.ProcessId
}

$rows = @()
foreach ($process in $managed) {
    $processId = [int]$process.ProcessId
    $parentPid = [int]$process.ParentProcessId
    $rootPid = Get-ManagedRootPid -Process $process
    $commandLine = [string]$process.CommandLine
    $rows += [pscustomobject]@{
        pid = $processId
        parent_pid = $parentPid
        root_pid = $rootPid
        is_root = [bool]($processId -eq $rootPid)
        is_listener = [bool]($listenerPid -and $processId -eq $listenerPid)
        visible_window = [bool]($visibleByPid[$processId])
        session_id = [int]$process.SessionId
        creation_date = [string]$process.CreationDate
        matches_profile = [bool]$commandLine.Contains($profile)
        matches_port = [bool]$commandLine.Contains($portFlag)
        command_line = $commandLine
    }
}

$roots = @($rows | Where-Object { $_.is_root } | Sort-Object creation_date)
$activeRootPid = $null
if ($listenerPid) {
    $listenerRow = $rows | Where-Object { $_.pid -eq $listenerPid } | Select-Object -First 1
    if ($listenerRow) { $activeRootPid = [int]$listenerRow.root_pid }
}

$classified = @($rows | ForEach-Object {
    $classification = if ($activeRootPid -and $_.root_pid -eq $activeRootPid) {
        'ACTIVE_MANAGED_TREE'
    } elseif ($_.is_root -and -not $_.visible_window) {
        'STALE_MANAGED_ROOT_CANDIDATE'
    } else {
        'STALE_MANAGED_DESCENDANT_CANDIDATE'
    }
    $_ | Add-Member -NotePropertyName classification -NotePropertyValue $classification -PassThru
})

[pscustomobject]@{
    ok = $true
    status = 'MANAGED_BROWSER_PROCESS_PREVIEW'
    profile = $profile
    listener_pid = $listenerPid
    active_root_pid = $activeRootPid
    managed_process_count = $classified.Count
    managed_root_count = $roots.Count
    candidate_process_count = @($classified | Where-Object { $_.classification -ne 'ACTIVE_MANAGED_TREE' }).Count
    processes = $classified | Sort-Object root_pid, creation_date, pid
} | ConvertTo-Json -Depth 8
