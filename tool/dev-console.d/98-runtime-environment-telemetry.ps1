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
                command_line = $commandLine
            }
        }
    }
    return $records
}

function Get-RuntimeEnvironmentConsoleProcess {
    $serverPid = $null
    if (Test-Path -LiteralPath $UnifiedPidFile -PathType Leaf) {
        try { $serverPid = [int](Get-Content -LiteralPath $UnifiedPidFile -Raw).Trim() } catch { $serverPid = $null }
    }
    $process = if ($serverPid) { Get-Process -Id $serverPid -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        watchdog_pid = $PID
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
    $latest = @($tasks | Sort-Object { try { [datetimeoffset]::Parse([string]$_.updated_at) } catch { [datetimeoffset]::MinValue } } -Descending | Select-Object -First 1)
    [pscustomobject]@{
        task_count = $tasks.Count
        counts = [pscustomobject]$counts
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
    }
    Add-Content -LiteralPath $RuntimeEnvironmentTelemetryFile -Value ($record | ConvertTo-Json -Depth 14 -Compress) -Encoding utf8
    $temporary = "$RuntimeEnvironmentStateFile.$PID.tmp"
    $record | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $RuntimeEnvironmentStateFile -Force
    return $record
}

function Get-RuntimeEnvironmentStatus {
    $record = Write-RuntimeEnvironmentTelemetry
    [pscustomobject]@{
        ok = [bool]($record.failure_classification -eq 'HEALTHY')
        status = if ($record.failure_classification -eq 'HEALTHY') { 'RUNTIME_ENVIRONMENT_HEALTHY' } else { 'RUNTIME_ENVIRONMENT_DEGRADED' }
        telemetry_file = $RuntimeEnvironmentTelemetryFile
        state_file = $RuntimeEnvironmentStateFile
        sample = $record
    }
}

Register-WatchdogCadenceLane -Name 'environment' -IntervalSeconds 60 -InsertBefore 'build_fingerprint' -Invoke {
    $record = Write-RuntimeEnvironmentTelemetry
    [pscustomobject]@{
        ok = [bool]($record.failure_classification -eq 'HEALTHY')
        status = if ($record.failure_classification -eq 'HEALTHY') { 'RUNTIME_ENVIRONMENT_HEALTHY' } else { 'RUNTIME_ENVIRONMENT_DEGRADED' }
        repair_required = $false
        detail = [pscustomobject]@{
            failure_classification = $record.failure_classification
            sampled_at = $record.sampled_at
            sample_gap_seconds = $record.sample_gap_seconds
        }
    }
}
