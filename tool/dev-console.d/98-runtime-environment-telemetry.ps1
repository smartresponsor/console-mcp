function ConvertTo-RuntimeEnvironmentSafeError {
    param([AllowNull()][object]$ErrorValue)
    if ($null -eq $ErrorValue) { return $null }
    return Sanitize-Text ([string]$ErrorValue)
}

function Get-RuntimeEnvironmentHttpProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$ExpectedBody = $null,
        [int]$TimeoutSeconds = 5
    )
    $started = Get-Date
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec $TimeoutSeconds -MaximumRedirection 5 -SkipHttpErrorCheck -ErrorAction Stop
        $body = [string]$response.Content
        try { $finalUri = [string]$response.BaseResponse.ResponseUri.AbsoluteUri } catch { $finalUri = $Uri }
        $hasExpectedBody = -not [string]::IsNullOrEmpty($ExpectedBody)
        $expectedBodyMatch = if (-not $hasExpectedBody) { $null } else { $body.Trim() -eq $ExpectedBody }
        $probeOk = if (-not $hasExpectedBody) { [int]$response.StatusCode -ge 100 -and [int]$response.StatusCode -lt 600 } else { [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400 -and $expectedBodyMatch }
        return [pscustomobject]@{
            name = $Name
            transport_ok = $true
            ok = [bool]$probeOk
            status_code = [int]$response.StatusCode
            elapsed_ms = [Math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
            final_uri = $finalUri
            redirected = [bool]($finalUri -and $finalUri -ne $Uri)
            expected_body_match = $expectedBodyMatch
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            name = $Name
            transport_ok = $false
            ok = $false
            status_code = $null
            elapsed_ms = [Math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
            final_uri = $null
            redirected = $false
            expected_body_match = $null
            error = ConvertTo-RuntimeEnvironmentSafeError $_.Exception.Message
        }
    }
}

function Get-RuntimeEnvironmentDnsProbe {
    param([string]$Name = 'chatgpt.com')
    $started = Get-Date
    try {
        $records = @(Resolve-DnsName -Name $Name -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 8)
        return [pscustomobject]@{
            ok = [bool]($records.Count -gt 0)
            name = $Name
            elapsed_ms = [Math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
            addresses = @($records | ForEach-Object { [string]$_.IPAddress })
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            name = $Name
            elapsed_ms = [Math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
            addresses = @()
            error = ConvertTo-RuntimeEnvironmentSafeError $_.Exception.Message
        }
    }
}

function Get-RuntimeEnvironmentNetworkInterfaces {
    $profiles = @()
    try {
        $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object {
            [pscustomobject]@{
                interface_alias = [string]$_.InterfaceAlias
                interface_index = [int]$_.InterfaceIndex
                network_category = [string]$_.NetworkCategory
                ipv4_connectivity = [string]$_.IPv4Connectivity
                ipv6_connectivity = [string]$_.IPv6Connectivity
            }
        })
    } catch { }

    $configurations = @()
    try {
        $configurations = @(Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
            [pscustomobject]@{
                interface_alias = [string]$_.InterfaceAlias
                interface_index = [int]$_.InterfaceIndex
                adapter_status = [string]$_.NetAdapter.Status
                adapter_description = [string]$_.NetAdapter.InterfaceDescription
                ipv4_addresses = @($_.IPv4Address | ForEach-Object { [string]$_.IPAddress })
                ipv4_gateways = @($_.IPv4DefaultGateway | ForEach-Object { [string]$_.NextHop })
                dns_servers = @($_.DNSServer.ServerAddresses | ForEach-Object { [string]$_ })
            }
        })
    } catch { }

    $wlanReport = $null
    try {
        $wlanRaw = ((& netsh wlan show interfaces 2>&1) | Out-String).Trim()
        $wlanSafe = Sanitize-Text $wlanRaw
        if ($wlanSafe.Length -gt 6000) { $wlanSafe = $wlanSafe.Substring(0, 6000) }
        $wlanReport = [pscustomobject]@{ ok = [bool]($LASTEXITCODE -eq 0); raw = $wlanSafe }
    } catch {
        $wlanReport = [pscustomobject]@{ ok = $false; raw = $null; error = ConvertTo-RuntimeEnvironmentSafeError $_.Exception.Message }
    }

    [pscustomobject]@{ profiles = $profiles; active_configurations = $configurations; wlan = $wlanReport }
}

function Get-RuntimeEnvironmentPowerEvidence {
    try { $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { $operatingSystem = $null }
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = (Get-Date).AddMinutes(-15) } -ErrorAction Stop |
            Where-Object {
                ($_.ProviderName -eq 'Microsoft-Windows-Kernel-Power' -and $_.Id -eq 42) -or
                ($_.ProviderName -eq 'Microsoft-Windows-Power-Troubleshooter' -and $_.Id -eq 1)
            } |
            Sort-Object TimeCreated -Descending |
            Select-Object -First 6 |
            ForEach-Object {
                [pscustomobject]@{
                    at = $_.TimeCreated.ToUniversalTime().ToString('o')
                    provider = [string]$_.ProviderName
                    id = [int]$_.Id
                    kind = if ($_.ProviderName -eq 'Microsoft-Windows-Kernel-Power' -and $_.Id -eq 42) { 'sleep' } else { 'resume' }
                }
            })
    } catch { }

    [pscustomobject]@{
        boot_time = if ($operatingSystem) { $operatingSystem.LastBootUpTime.ToUniversalTime().ToString('o') } else { $null }
        power_events_last_15m = $events
    }
}

function Get-RuntimeEnvironmentPortOwnership {
    param([int[]]$Ports = @($ReservedBrowserDevToolsPorts))
    $browserRoot = Join-Path (Split-Path -Parent $Root) 'browser'
    $records = @()
    foreach ($port in $Ports) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) {
            $records += [pscustomobject]@{
                port = [int]$port
                role = if ($port -eq $RequiredBrowserDevToolsPort) { 'required_primary' } else { 'reserved_standby' }
                state = if ($port -eq $RequiredBrowserDevToolsPort) { 'REQUIRED_PORT_UNBOUND' } else { 'RESERVED_STANDBY_FREE' }
                owner_expected = $false
                pid = $null
                process_name = $null
                command_line = $null
                command_line_persisted = $false
                expected_remote_debugging_port_flag = $false
                expected_browser_profile_flag = $false
            }
            continue
        }
        foreach ($listener in $listeners) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
            $processName = if ($process) { [string]$process.Name } else { $null }
            $commandLine = if ($process) { Sanitize-Text ([string]$process.CommandLine) } else { $null }
            $expectedBrowserName = $processName -match '^(msedge|chrome|chromium)\.exe$'
            $expectedPortFlag = $commandLine -and $commandLine.Contains("--remote-debugging-port=$port")
            $expectedProfile = $commandLine -and ($commandLine.Contains($browserRoot) -or $commandLine.Contains('CONSOLE_MCP_BROWSER_USER_DATA_DIR'))
            $ownerExpected = [bool]($expectedBrowserName -and $expectedPortFlag -and $expectedProfile)
            $records += [pscustomobject]@{
                port = [int]$port
                role = if ($port -eq $RequiredBrowserDevToolsPort) { 'required_primary' } else { 'reserved_standby' }
                state = if ($ownerExpected) { 'RESERVED_PORT_EXPECTED_OWNER' } else { 'RESERVED_PORT_FOREIGN_OWNER' }
                owner_expected = $ownerExpected
                pid = [int]$listener.OwningProcess
                process_name = $processName
                command_line = $null
                command_line_persisted = $false
                expected_remote_debugging_port_flag = [bool]$expectedPortFlag
                expected_browser_profile_flag = [bool]$expectedProfile
            }
        }
    }
    return $records
}

function Get-RuntimeEnvironmentConsoleProcess {
    $watchdogPid = $null
    if (Test-Path -LiteralPath $WatchdogLoopPidFile -PathType Leaf) {
        try { $watchdogPid = [int](Get-Content -LiteralPath $WatchdogLoopPidFile -Raw).Trim() } catch { $watchdogPid = $null }
    }
    $serverPid = $null
    if (Test-Path -LiteralPath $UnifiedPidFile -PathType Leaf) {
        try { $serverPid = [int](Get-Content -LiteralPath $UnifiedPidFile -Raw).Trim() } catch { $serverPid = $null }
    }
    $process = if ($serverPid) { Get-Process -Id $serverPid -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        watchdog_pid = $watchdogPid
        sampler_pid = $PID
        console_mcp_pid = $serverPid
        console_mcp_alive = [bool]$process
        console_mcp_started_at = $(try { if ($process) { $process.StartTime.ToUniversalTime().ToString('o') } else { $null } } catch { $null })
        console_mcp_uptime_seconds = $(try { if ($process) { [Math]::Round(((Get-Date) - $process.StartTime).TotalSeconds, 1) } else { $null } } catch { $null })
    }
}

function Get-RuntimeEnvironmentEngineSnapshot {
    $taskDir = Join-Path $Root 'var\run\engine\task'
    if (-not (Test-Path -LiteralPath $taskDir -PathType Container)) {
        return [pscustomobject]@{ task_count = 0; counts = [pscustomobject]@{}; latest_task = $null }
    }
    $tasks = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $taskDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        try {
            $task = Get-Content -LiteralPath $item.FullName -Raw | ConvertFrom-Json
            if ($task) { $tasks += $task }
        } catch { }
    }
    $counts = [ordered]@{}
    foreach ($group in @($tasks | Group-Object status)) { $counts[[string]$group.Name] = [int]$group.Count }
    $pressureCutoff = [datetimeoffset]::UtcNow.AddHours(-6)
    $pressureTasks = @($tasks | Where-Object {
        $status = ([string]$_.status).ToLowerInvariant()
        if ($status -match 'blocked|failed|error|completed|done|cancelled') { return $false }
        try { return [datetimeoffset]::Parse([string]$_.updated_at).ToUniversalTime() -ge $pressureCutoff } catch { return $false }
    })
    $pressureCounts = [ordered]@{}
    foreach ($group in @($pressureTasks | Group-Object status)) { $pressureCounts[[string]$group.Name] = [int]$group.Count }
    $staleNonterminal = @($tasks | Where-Object {
        $status = ([string]$_.status).ToLowerInvariant()
        if ($status -match 'blocked|failed|error|completed|done|cancelled') { return $false }
        try { return [datetimeoffset]::Parse([string]$_.updated_at).ToUniversalTime() -lt $pressureCutoff } catch { return $true }
    })
    $latest = @($tasks | Sort-Object { try { [datetimeoffset]::Parse([string]$_.updated_at) } catch { [datetimeoffset]::MinValue } } -Descending | Select-Object -First 1)
    [pscustomobject]@{
        task_count = $tasks.Count
        counts = [pscustomobject]$counts
        pressure_counts = [pscustomobject]$pressureCounts
        pressure_task_count = $pressureTasks.Count
        stale_nonterminal_task_count = $staleNonterminal.Count
        latest_task = if ($latest.Count -gt 0) {
            [pscustomobject]@{
                task_id = [string]$latest[0].task_id
                component = [string]$latest[0].component
                status = [string]$latest[0].status
                updated_at = $(if ($latest[0].updated_at -is [datetime]) { $latest[0].updated_at.ToUniversalTime().ToString('o') } else { [string]$latest[0].updated_at })
                next_action = [string]$latest[0].next_action
                chat_id = $latest[0].chat_id
                target_id = $latest[0].target_id
                submitted_at = $latest[0].submitted_at
                answer_captured_at = $latest[0].answer_captured_at
                assistant_length = $latest[0].assistant_length
                ready_to_delete = $latest[0].ready_to_delete
                execution_blocked_stage = $latest[0].execution_blocked_stage
                execution_blocked_reason = $latest[0].execution_blocked_reason
            }
        } else { $null }
    }
}

function ConvertTo-RuntimeEnvironmentBoundedNumber {
    param(
        [AllowNull()][object]$Value,
        [double]$Min = 0,
        [AllowNull()][object]$Max = $null,
        [int]$Decimals = 1
    )
    if ($null -eq $Value) { return $null }
    try {
        $number = [double]$Value
        if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return $null }
        if ($number -lt $Min) { $number = $Min }
        if ($null -ne $Max) {
            $maximum = [double]$Max
            if ($number -gt $maximum) { $number = $maximum }
        }
        return [Math]::Round($number, $Decimals)
    } catch {
        return $null
    }
}

function New-RuntimeEnvironmentTelemetryError {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [AllowNull()][object]$ErrorValue
    )
    [pscustomobject]@{
        source = $Source
        error = ConvertTo-RuntimeEnvironmentSafeError $ErrorValue
    }
}

function New-RuntimeProcessFamilyRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [object[]]$Processes = @()
    )
    $items = @($Processes)
    $privateBytes = [double](@($items | ForEach-Object { try { [double]$_.PrivateMemorySize64 } catch { 0 } } | Measure-Object -Sum).Sum)
    $workingSetBytes = [double](@($items | ForEach-Object { try { [double]$_.WorkingSet64 } catch { 0 } } | Measure-Object -Sum).Sum)
    $cpuSeconds = [double](@($items | ForEach-Object { try { if ($null -ne $_.CPU) { [double]$_.CPU } else { 0 } } catch { 0 } } | Measure-Object -Sum).Sum)
    $pids = @($items | ForEach-Object { try { [int]$_.Id } catch { $null } } | Where-Object { $null -ne $_ } | Sort-Object | Select-Object -First 32)

    [pscustomobject]@{
        name = $Name
        count = [int]$items.Count
        private_memory_mb = ConvertTo-RuntimeEnvironmentBoundedNumber ($privateBytes / 1MB) -Min 0 -Decimals 1
        working_set_mb = ConvertTo-RuntimeEnvironmentBoundedNumber ($workingSetBytes / 1MB) -Min 0 -Decimals 1
        cpu_seconds = ConvertTo-RuntimeEnvironmentBoundedNumber $cpuSeconds -Min 0 -Decimals 1
        pids_sample = $pids
        pids_sample_truncated = [bool]($items.Count -gt $pids.Count)
    }
}

function Get-RuntimeEnvironmentFamilyName {
    param([AllowNull()][string]$ProcessName)
    $name = ([string]$ProcessName).ToLowerInvariant()
    if ($name -match '^(php|php-cgi|phpdbg)$') { return 'php' }
    if ($name -eq 'node') { return 'node' }
    if ($name -match '^(msedge|chrome|chromium)$') { return 'edge' }
    if ($name -match '^(powershell|pwsh)$') { return 'powershell' }
    if ($name -match '^(cmd|conhost|bash|sh|wsl|wslhost)$') { return 'shell' }
    return 'other'
}

function Get-RuntimeEnvironmentCpuLoad {
    param([System.Collections.ArrayList]$TelemetryErrors)
    try {
        $processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
        $loads = @($processors | ForEach-Object {
            if ($null -ne $_.LoadPercentage) { [double]$_.LoadPercentage }
        })
        if ($loads.Count -eq 0) { return $null }
        return ConvertTo-RuntimeEnvironmentBoundedNumber ((@($loads | Measure-Object -Average).Average)) -Min 0 -Max 100 -Decimals 1
    } catch {
        [void]$TelemetryErrors.Add((New-RuntimeEnvironmentTelemetryError -Source 'Win32_Processor' -ErrorValue $_.Exception.Message))
        return $null
    }
}

function Get-RuntimeEnvironmentHostMemory {
    param([System.Collections.ArrayList]$TelemetryErrors)
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $totalPhysicalMb = ConvertTo-RuntimeEnvironmentBoundedNumber ([double]$os.TotalVisibleMemorySize / 1024.0) -Min 0 -Decimals 1
        $availablePhysicalMb = ConvertTo-RuntimeEnvironmentBoundedNumber ([double]$os.FreePhysicalMemory / 1024.0) -Min 0 -Decimals 1
        $physicalUsedPercent = $null
        if ($null -ne $totalPhysicalMb -and $totalPhysicalMb -gt 0 -and $null -ne $availablePhysicalMb) {
            $physicalUsedPercent = ConvertTo-RuntimeEnvironmentBoundedNumber ((($totalPhysicalMb - $availablePhysicalMb) / $totalPhysicalMb) * 100.0) -Min 0 -Max 100 -Decimals 1
        }

        [pscustomobject]@{
            total_physical_mb = $totalPhysicalMb
            available_physical_mb = $availablePhysicalMb
            physical_used_percent = $physicalUsedPercent
            source = 'Win32_OperatingSystem'
        }
    } catch {
        [void]$TelemetryErrors.Add((New-RuntimeEnvironmentTelemetryError -Source 'Win32_OperatingSystem' -ErrorValue $_.Exception.Message))
        [pscustomobject]@{
            total_physical_mb = $null
            available_physical_mb = $null
            physical_used_percent = $null
            source = 'unavailable'
        }
    }
}

function Get-RuntimeEnvironmentCommitUsage {
    param([System.Collections.ArrayList]$TelemetryErrors)
    try {
        $counter = Get-Counter -Counter '\Memory\Committed Bytes','\Memory\Commit Limit' -ErrorAction Stop
        $committedBytes = $null
        $limitBytes = $null
        foreach ($sample in @($counter.CounterSamples)) {
            if ($sample.Path -match 'committed bytes$') { $committedBytes = [double]$sample.CookedValue }
            if ($sample.Path -match 'commit limit$') { $limitBytes = [double]$sample.CookedValue }
        }
        $committedMb = ConvertTo-RuntimeEnvironmentBoundedNumber ($committedBytes / 1MB) -Min 0 -Decimals 1
        $limitMb = ConvertTo-RuntimeEnvironmentBoundedNumber ($limitBytes / 1MB) -Min 0 -Decimals 1
        $percent = $null
        if ($null -ne $committedMb -and $null -ne $limitMb -and $limitMb -gt 0) {
            $percent = ConvertTo-RuntimeEnvironmentBoundedNumber (($committedMb / $limitMb) * 100.0) -Min 0 -Max 100 -Decimals 1
        }
        return [pscustomobject]@{
            committed_mb = $committedMb
            limit_mb = $limitMb
            utilization_percent = $percent
            source = 'Get-Counter'
        }
    } catch {
        [void]$TelemetryErrors.Add((New-RuntimeEnvironmentTelemetryError -Source 'Get-Counter:MemoryCommit' -ErrorValue $_.Exception.Message))
    }

    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $limitMb = ConvertTo-RuntimeEnvironmentBoundedNumber ([double]$os.TotalVirtualMemorySize / 1024.0) -Min 0 -Decimals 1
        $freeMb = ConvertTo-RuntimeEnvironmentBoundedNumber ([double]$os.FreeVirtualMemory / 1024.0) -Min 0 -Decimals 1
        $committedMb = $null
        $percent = $null
        if ($null -ne $limitMb -and $null -ne $freeMb) {
            $committedMb = ConvertTo-RuntimeEnvironmentBoundedNumber ($limitMb - $freeMb) -Min 0 -Decimals 1
            if ($limitMb -gt 0) {
                $percent = ConvertTo-RuntimeEnvironmentBoundedNumber (($committedMb / $limitMb) * 100.0) -Min 0 -Max 100 -Decimals 1
            }
        }
        return [pscustomobject]@{
            committed_mb = $committedMb
            limit_mb = $limitMb
            utilization_percent = $percent
            source = 'Win32_OperatingSystem'
        }
    } catch {
        [void]$TelemetryErrors.Add((New-RuntimeEnvironmentTelemetryError -Source 'Win32_OperatingSystem:VirtualMemory' -ErrorValue $_.Exception.Message))
        return [pscustomobject]@{
            committed_mb = $null
            limit_mb = $null
            utilization_percent = $null
            source = 'unavailable'
        }
    }
}

function Get-RuntimeEnvironmentProcessFamilies {
    param(
        [AllowNull()][int]$ConsoleMcpPid,
        [System.Collections.ArrayList]$TelemetryErrors
    )
    $processes = @()
    try {
        $processes = @(Get-Process -ErrorAction Stop)
    } catch {
        [void]$TelemetryErrors.Add((New-RuntimeEnvironmentTelemetryError -Source 'Get-Process' -ErrorValue $_.Exception.Message))
    }

    $familyNames = @('php', 'node', 'edge', 'powershell', 'shell')
    $familyMap = @{}
    foreach ($family in $familyNames) { $familyMap[$family] = New-Object System.Collections.ArrayList }
    $consoleMcpProcesses = New-Object System.Collections.ArrayList

    foreach ($processItem in $processes) {
        $family = Get-RuntimeEnvironmentFamilyName -ProcessName $processItem.ProcessName
        if ($familyMap.ContainsKey($family)) { [void]$familyMap[$family].Add($processItem) }
        if ($ConsoleMcpPid -and $processItem.Id -eq $ConsoleMcpPid) { [void]$consoleMcpProcesses.Add($processItem) }
    }

    $records = [ordered]@{}
    foreach ($family in $familyNames) {
        $records[$family] = New-RuntimeProcessFamilyRecord -Name $family -Processes @($familyMap[$family])
    }
    $records['console_mcp'] = New-RuntimeProcessFamilyRecord -Name 'console_mcp' -Processes @($consoleMcpProcesses)
    return [pscustomobject]$records
}

function Get-RuntimeEnvironmentResourcePressure {
    param(
        [Parameter(Mandatory = $true)]$Memory,
        [Parameter(Mandatory = $true)]$Commit,
        [AllowNull()][object]$CpuPercent
    )
    $signals = @()
    $level = 'NORMAL'

    if ($null -ne $Memory.available_physical_mb -and $Memory.available_physical_mb -lt 512) {
        $level = 'CRITICAL'
        $signals += 'available_physical_mb_below_512'
    } elseif ($null -ne $Memory.available_physical_mb -and $Memory.available_physical_mb -lt 1024 -and $level -ne 'CRITICAL') {
        $level = 'WARN'
        $signals += 'available_physical_mb_below_1024'
    }

    if ($null -ne $Memory.physical_used_percent -and $Memory.physical_used_percent -ge 95) {
        $level = 'CRITICAL'
        $signals += 'physical_used_percent_ge_95'
    } elseif ($null -ne $Memory.physical_used_percent -and $Memory.physical_used_percent -ge 85 -and $level -notin @('CRITICAL')) {
        $level = 'WARN'
        $signals += 'physical_used_percent_ge_85'
    }

    if ($null -ne $Commit.utilization_percent -and $Commit.utilization_percent -ge 95) {
        $level = 'CRITICAL'
        $signals += 'commit_utilization_percent_ge_95'
    } elseif ($null -ne $Commit.utilization_percent -and $Commit.utilization_percent -ge 85 -and $level -notin @('CRITICAL')) {
        $level = 'WARN'
        $signals += 'commit_utilization_percent_ge_85'
    }

    if ($null -ne $CpuPercent -and [double]$CpuPercent -ge 95 -and $level -eq 'NORMAL') {
        $level = 'WATCH'
        $signals += 'cpu_percent_ge_95'
    }

    [pscustomobject]@{
        level = $level
        under_pressure = [bool]($level -in @('WARN','CRITICAL'))
        signals = $signals
        note = 'Single-sample classification only; use repeated telemetry to diagnose accumulation or leaks.'
    }
}

function Get-RuntimeEnvironmentNumberOrZero {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return 0 }
    try {
        $number = [double]$Value
        if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 0 }
        return $number
    } catch {
        return 0
    }
}

function Get-RuntimeEnvironmentEngineExecutionPressure {
    param([Parameter(Mandatory = $true)]$Engine)
    $counts = if ($Engine.pressure_counts) { $Engine.pressure_counts } else { $Engine.counts }
    $active = 0
    $queued = 0
    $blocked = 0
    foreach ($property in @($counts.PSObject.Properties)) {
        $name = ([string]$property.Name).ToLowerInvariant()
        $value = try { [int]$property.Value } catch { 0 }
        if ($name -match 'running|active|submitted|in_progress|executing|waiting_assistant') { $active += $value }
        if ($name -match 'queued|pending|ready|planned') { $queued += $value }
        if ($name -match 'blocked|failed|error') { $blocked += $value }
    }
    $status = if ($active -ge 3 -or $queued -ge 10) { 'HIGH' } elseif ($active -gt 0 -or $queued -gt 0) { 'ACTIVE' } elseif ($blocked -gt 0) { 'BLOCKED_OR_FAILED_PRESENT' } else { 'IDLE' }
    [pscustomobject]@{
        status = $status
        active_task_count = [int]$active
        queued_task_count = [int]$queued
        blocked_or_failed_task_count = [int]$blocked
        total_task_count = [int]$Engine.task_count
    }
}

function Get-RuntimeEnvironmentResourceDeltas {
    param(
        [AllowNull()]$Previous,
        [Parameter(Mandatory = $true)]$Resources
    )
    if (-not $Previous -or -not $Previous.resources) { return $null }
    $previousResources = $Previous.resources
    $families = [ordered]@{}
    foreach ($familyName in @('php','node','edge','powershell','shell','console_mcp')) {
        $currentFamily = $Resources.process_families.$familyName
        $previousFamily = $previousResources.process_families.$familyName
        $currentCount = Get-RuntimeEnvironmentNumberOrZero $currentFamily.count
        $previousCount = Get-RuntimeEnvironmentNumberOrZero $previousFamily.count
        $currentPrivateMemoryMb = Get-RuntimeEnvironmentNumberOrZero $currentFamily.private_memory_mb
        $previousPrivateMemoryMb = Get-RuntimeEnvironmentNumberOrZero $previousFamily.private_memory_mb
        $currentWorkingSetMb = Get-RuntimeEnvironmentNumberOrZero $currentFamily.working_set_mb
        $previousWorkingSetMb = Get-RuntimeEnvironmentNumberOrZero $previousFamily.working_set_mb
        $families[$familyName] = [pscustomobject]@{
            count_delta = [int]($currentCount - $previousCount)
            private_memory_mb_delta = ConvertTo-RuntimeEnvironmentBoundedNumber ($currentPrivateMemoryMb - $previousPrivateMemoryMb) -Min -1048576 -Decimals 1
            working_set_mb_delta = ConvertTo-RuntimeEnvironmentBoundedNumber ($currentWorkingSetMb - $previousWorkingSetMb) -Min -1048576 -Decimals 1
        }
    }

    $currentAvailableMb = Get-RuntimeEnvironmentNumberOrZero $Resources.host.available_physical_mb
    $previousAvailableMb = Get-RuntimeEnvironmentNumberOrZero $previousResources.host.available_physical_mb
    $currentCommitPercent = Get-RuntimeEnvironmentNumberOrZero $Resources.commit.utilization_percent
    $previousCommitPercent = Get-RuntimeEnvironmentNumberOrZero $previousResources.commit.utilization_percent
    $currentCpuPercent = Get-RuntimeEnvironmentNumberOrZero $Resources.cpu_percent
    $previousCpuPercent = Get-RuntimeEnvironmentNumberOrZero $previousResources.cpu_percent

    [pscustomobject]@{
        host = [pscustomobject]@{
            available_physical_mb_delta = ConvertTo-RuntimeEnvironmentBoundedNumber ($currentAvailableMb - $previousAvailableMb) -Min -1048576 -Decimals 1
            commit_utilization_percent_delta = ConvertTo-RuntimeEnvironmentBoundedNumber ($currentCommitPercent - $previousCommitPercent) -Min -100 -Max 100 -Decimals 1
            cpu_percent_delta = ConvertTo-RuntimeEnvironmentBoundedNumber ($currentCpuPercent - $previousCpuPercent) -Min -100 -Max 100 -Decimals 1
        }
        process_families = [pscustomobject]$families
    }
}

function Get-RuntimeEnvironmentResourceSnapshot {
    param(
        [AllowNull()]$Previous,
        [AllowNull()][int]$ConsoleMcpPid,
        [Parameter(Mandatory = $true)]$Engine
    )
    $telemetryErrors = New-Object System.Collections.ArrayList
    $hostMemory = Get-RuntimeEnvironmentHostMemory -TelemetryErrors $telemetryErrors
    $commit = Get-RuntimeEnvironmentCommitUsage -TelemetryErrors $telemetryErrors
    $cpuPercent = Get-RuntimeEnvironmentCpuLoad -TelemetryErrors $telemetryErrors
    $families = Get-RuntimeEnvironmentProcessFamilies -ConsoleMcpPid $ConsoleMcpPid -TelemetryErrors $telemetryErrors
    $pressure = Get-RuntimeEnvironmentResourcePressure -Memory $hostMemory -Commit $commit -CpuPercent $cpuPercent
    $enginePressure = Get-RuntimeEnvironmentEngineExecutionPressure -Engine $Engine

    $resources = [pscustomobject]@{
        schema_version = 1
        host = $hostMemory
        commit = $commit
        cpu_percent = $cpuPercent
        process_families = $families
        resource_pressure = $pressure
        engine_execution_pressure = $enginePressure
        telemetry_errors = @($telemetryErrors)
        privacy = [pscustomobject]@{
            raw_command_lines_persisted = $false
            process_details = 'aggregated_by_family'
        }
    }
    $resources | Add-Member -NotePropertyName deltas -NotePropertyValue (Get-RuntimeEnvironmentResourceDeltas -Previous $Previous -Resources $resources)
    return $resources
}

function Get-RuntimeEnvironmentPreviousState {
    if (-not (Test-Path -LiteralPath $RuntimeEnvironmentStateFile -PathType Leaf)) { return $null }
    try { Get-Content -LiteralPath $RuntimeEnvironmentStateFile -Raw | ConvertFrom-Json } catch { $null }
}

function Get-RuntimeEnvironmentFailureClassification {
    param(
        [Parameter(Mandatory = $true)]$Dns,
        [Parameter(Mandatory = $true)]$ConnectivityProbe,
        [Parameter(Mandatory = $true)]$ChatgptProbe,
        [Parameter(Mandatory = $true)][object[]]$Ports,
        [Parameter(Mandatory = $true)]$Power
    )
    if (@($Ports | Where-Object { $_.state -eq 'RESERVED_PORT_FOREIGN_OWNER' }).Count -gt 0) { return 'DEVTOOLS_PORT_FOREIGN_OWNER' }
    if (@($Ports | Where-Object { $_.port -eq $RequiredBrowserDevToolsPort -and $_.state -eq 'REQUIRED_PORT_UNBOUND' }).Count -gt 0) { return 'DEVTOOLS_PRIMARY_UNBOUND' }
    if (@($Power.power_events_last_15m | Where-Object { $_.kind -in @('sleep','resume') }).Count -gt 0) { return 'HOST_SLEEP_RESUME_OBSERVED' }
    if (-not $Dns.ok) { return 'DNS_FAILURE' }
    if (-not $ConnectivityProbe.ok -and $ConnectivityProbe.status_code -and -not $ConnectivityProbe.expected_body_match) { return 'CAPTIVE_PORTAL_SUSPECTED' }
    if (-not $ConnectivityProbe.ok) { return 'INTERNET_CONNECTIVITY_FAILURE' }
    if (-not $ChatgptProbe.ok) { return 'CHATGPT_REACHABILITY_FAILURE' }
    return 'HEALTHY'
}

function Write-RuntimeEnvironmentTelemetry {
    $sampledAt = [datetimeoffset]::UtcNow
    $sampledAtUnixMs = $sampledAt.ToUnixTimeMilliseconds()
    $previous = Get-RuntimeEnvironmentPreviousState
    $dns = Get-RuntimeEnvironmentDnsProbe
    $connectivity = Get-RuntimeEnvironmentHttpProbe -Name 'windows_connectivity' -Uri 'http://www.msftconnecttest.com/connecttest.txt' -ExpectedBody 'Microsoft Connect Test'
    $chatgpt = Get-RuntimeEnvironmentHttpProbe -Name 'chatgpt' -Uri 'https://chatgpt.com/'
    $interfaces = Get-RuntimeEnvironmentNetworkInterfaces
    $power = Get-RuntimeEnvironmentPowerEvidence
    $ports = @(Get-RuntimeEnvironmentPortOwnership)
    $process = Get-RuntimeEnvironmentConsoleProcess
    $engine = Get-RuntimeEnvironmentEngineSnapshot
    $resources = Get-RuntimeEnvironmentResourceSnapshot -Previous $previous -ConsoleMcpPid $process.console_mcp_pid -Engine $engine
    $classification = Get-RuntimeEnvironmentFailureClassification -Dns $dns -ConnectivityProbe $connectivity -ChatgptProbe $chatgpt -Ports $ports -Power $power
    $sampleGapSeconds = $null
    if ($previous -and $previous.sampled_at_unix_ms) {
        try { $sampleGapSeconds = [Math]::Round(($sampledAtUnixMs - [int64]$previous.sampled_at_unix_ms) / 1000.0, 1) } catch { }
    }

    $record = [pscustomobject]@{
        schema_version = 1
        sampled_at = $sampledAt.ToString('o')
        sampled_at_unix_ms = $sampledAtUnixMs
        sample_gap_seconds = $sampleGapSeconds
        failure_classification = $classification
        internet = [pscustomobject]@{ dns = $dns; connectivity = $connectivity; chatgpt = $chatgpt }
        network = $interfaces
        power = $power
        devtools_ports = $ports
        process = $process
        engine = $engine
        resources = $resources
        resource_pressure = $resources.resource_pressure
        engine_execution_pressure = $resources.engine_execution_pressure
    }
    Add-Content -LiteralPath $RuntimeEnvironmentTelemetryFile -Value ($record | ConvertTo-Json -Depth 14 -Compress) -Encoding utf8
    $temporary = "$RuntimeEnvironmentStateFile.$PID.tmp"
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $RuntimeEnvironmentStateFile -Force
    return $record
}

function Invoke-RuntimeEnvironmentTelemetrySample {
    $lockPath = Join-Path $RunDir 'runtime-environment-sample.lock'
    $lockHandle = $null
    try {
        try {
            $lockHandle = [System.IO.File]::Open(
                $lockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        } catch [System.IO.IOException] {
            return [pscustomobject]@{ ok=$true; status='RUNTIME_ENVIRONMENT_SAMPLE_ALREADY_RUNNING'; sampled=$false; lock_file=$lockPath }
        }
        $record = Write-RuntimeEnvironmentTelemetry
        return [pscustomobject]@{
            ok = [bool]($record.failure_classification -eq 'HEALTHY')
            status = if ($record.failure_classification -eq 'HEALTHY') { 'RUNTIME_ENVIRONMENT_SAMPLE_COMPLETED' } else { 'RUNTIME_ENVIRONMENT_SAMPLE_DEGRADED' }
            sampled = $true
            sampled_at = $record.sampled_at
            failure_classification = $record.failure_classification
            lock_file = $lockPath
        }
    } finally {
        if ($lockHandle) { try { $lockHandle.Dispose() } catch {} }
    }
}

function Start-RuntimeEnvironmentTelemetrySample {
    $devConsole = Join-Path $Root 'tool\dev-console.ps1'
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $process = Start-Process -FilePath $pwsh -ArgumentList @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy','Bypass',
        '-File', $devConsole,
        'runtime-environment-sample'
    ) -WindowStyle Hidden -PassThru
    [pscustomobject]@{
        ok = $true
        status = 'RUNTIME_ENVIRONMENT_SAMPLE_STARTED'
        repair_required = $false
        detail = [pscustomobject]@{ sampler_pid=[int]$process.Id; state_file=$RuntimeEnvironmentStateFile }
    }
}

function Get-RuntimeEnvironmentStatus {
    $record = Get-RuntimeEnvironmentPreviousState
    if (-not $record) {
        return [pscustomobject]@{
            ok = $false
            status = 'RUNTIME_ENVIRONMENT_UNAVAILABLE'
            telemetry_file = $RuntimeEnvironmentTelemetryFile
            state_file = $RuntimeEnvironmentStateFile
            sample_age_seconds = $null
            stale = $true
            sample = $null
            next_action = 'wait for the environment watchdog cadence sample'
        }
    }

    $sampledValue = $record.sampled_at
    $sampledAt = if ($sampledValue -is [datetimeoffset]) {
        $sampledValue.ToUniversalTime()
    } elseif ($sampledValue -is [datetime]) {
        [datetimeoffset]::new($sampledValue.ToUniversalTime())
    } else {
        [datetimeoffset]::Parse([string]$sampledValue).ToUniversalTime()
    }
    $age = [Math]::Round(([datetimeoffset]::UtcNow - $sampledAt).TotalSeconds, 1)
    $stale = [bool]($age -gt 180 -or $age -lt -5)
    $healthy = [bool]($record.failure_classification -eq 'HEALTHY' -and -not $stale)

    [pscustomobject]@{
        ok = $healthy
        status = if ($stale) { 'RUNTIME_ENVIRONMENT_STALE' } elseif ($record.failure_classification -eq 'HEALTHY') { 'RUNTIME_ENVIRONMENT_HEALTHY' } else { 'RUNTIME_ENVIRONMENT_DEGRADED' }
        telemetry_file = $RuntimeEnvironmentTelemetryFile
        state_file = $RuntimeEnvironmentStateFile
        sample_age_seconds = $age
        stale = $stale
        sampled_at = $record.sampled_at
        failure_classification = $record.failure_classification
        resource_pressure = $record.resource_pressure
        engine_execution_pressure = $record.engine_execution_pressure
        process = $record.process
        telemetry_errors = @($record.resources.telemetry_errors)
        next_action = if ($stale) { 'wait for the next environment watchdog cadence sample' } else { 'none' }
    }
}

Register-WatchdogCadenceLane -Name 'environment' -IntervalSeconds 60 -InsertBefore 'build_fingerprint' -Invoke {
    Start-RuntimeEnvironmentTelemetrySample
}
