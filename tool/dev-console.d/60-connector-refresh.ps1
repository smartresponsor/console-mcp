function Get-DefaultExpectedSurface {
    $configured = $env:CONSOLE_MCP_EXPECTED_TOOLS
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return @($configured.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    }

    return Get-PolicyExpectedToolSurface
}

function Get-PolicyExpectedToolSurface {
    $indexPath = Join-Path $Root 'policy/console-tool-catalog-index.json'
    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
    $names = @()
    foreach ($fragmentPath in @($index.fragments)) {
        $fragmentFullPath = Join-Path $Root ([string]$fragmentPath)
        $fragment = Get-Content -LiteralPath $fragmentFullPath -Raw | ConvertFrom-Json
        foreach ($tool in @($fragment.tools)) {
            if ($tool.canonicalName) {
                $names += [string]$tool.canonicalName
            }
            foreach ($extraName in @($tool.canonicalReadAliases)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$extraName)) {
                    $names += [string]$extraName
                }
            }
        }
    }

    return @($names | Sort-Object -Unique)
}

function Compare-ToolSurface {
    param(
        [string[]]$ExpectedTools = @(),
        [string[]]$RuntimeTools = @()
    )

    $expected = @($ExpectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $runtime = @($RuntimeTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $missing = @($expected | Where-Object { $runtime -notcontains $_ })
    $unexpected = @($runtime | Where-Object { $expected -notcontains $_ })

    return [pscustomobject]@{
        ok = $missing.Count -eq 0 -and $unexpected.Count -eq 0
        status = if ($missing.Count -eq 0 -and $unexpected.Count -eq 0) { 'RUNTIME_TOOLS_MATCH_EXPECTED' } else { 'RUNTIME_TOOLS_DIFFER_FROM_EXPECTED' }
        expected_count = $expected.Count
        runtime_count = $runtime.Count
        missing_count = $missing.Count
        unexpected_count = $unexpected.Count
        missing = $missing
        unexpected = $unexpected
    }
}

function Get-ChatgptConnectorRefreshState {
    if (-not (Test-Path -LiteralPath $ConnectorRefreshStateFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            status = 'never-run'
            state_file = $ConnectorRefreshStateFile
        }
    }

    try {
        return (Get-Content -LiteralPath $ConnectorRefreshStateFile -Raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            ok = $false
            status = 'state-file-unreadable'
            state_file = $ConnectorRefreshStateFile
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-ChatgptConnectorCanaryCallAfter {
    param(
        [Parameter(Mandatory = $true)][datetime]$NotBefore,
        [string]$ToolName = 'console.read_.system.console.health'
    )

    if (-not (Test-Path -LiteralPath $McpMethodTraceFile -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            observed = $false
            status = 'CANARY_TRACE_FILE_MISSING'
            trace_file = $McpMethodTraceFile
            expected_tool_name = $ToolName
        }
    }

    $matched = $null
    try {
        $lines = Get-Content -LiteralPath $McpMethodTraceFile -Tail 2000 -ErrorAction Stop
        foreach ($line in $lines) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $record = $line | ConvertFrom-Json
                if ($record.consumer -ne 'chatgpt') { continue }
                if ($record.event -ne 'method_end') { continue }
                if ($record.method -ne 'tools/call') { continue }
                if ($record.result_classification -ne 'transport_completed') { continue }
                if ([int]$record.http_status -ne 200) { continue }
                if (-not [string]::IsNullOrWhiteSpace($ToolName) -and [string]$record.tool_name -ne $ToolName) { continue }
                $recordAt = [datetime]::Parse([string]$record.timestamp)
                if ($recordAt.ToUniversalTime() -lt $NotBefore.ToUniversalTime().AddSeconds(-1)) { continue }
                $matched = $record
            } catch {
                continue
            }
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            observed = $false
            status = 'CANARY_TRACE_UNREADABLE'
            trace_file = $McpMethodTraceFile
            expected_tool_name = $ToolName
            error = Sanitize-Text $_.Exception.Message
        }
    }

    if (-not $matched) {
        return [pscustomobject]@{
            ok = $false
            observed = $false
            status = 'CANARY_TOOLS_CALL_NOT_OBSERVED'
            trace_file = $McpMethodTraceFile
            expected_tool_name = $ToolName
            not_before = $NotBefore.ToUniversalTime().ToString('o')
        }
    }

    return [pscustomobject]@{
        ok = $true
        observed = $true
        status = 'CANARY_TOOLS_CALL_OBSERVED'
        trace_file = $McpMethodTraceFile
        expected_tool_name = $ToolName
        observed_at = [string]$matched.timestamp
        correlation_id = [string]$matched.correlation_id
        tool_name = [string]$matched.tool_name
        http_status = [int]$matched.http_status
        pid = $matched.pid
    }
}

function Resolve-PendingChatgptConnectorRefresh {
    $state = Get-ChatgptConnectorRefreshState
    if (-not $state -or $state.status -notin @('CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING', 'CONNECTOR_SCHEMA_PROPAGATION_CANARY_PENDING')) {
        return $state
    }
    if (-not $state.schema_propagation -or $state.schema_propagation.ui_confirmed -ne $true) {
        return $state
    }
    if (-not (Test-Path -LiteralPath $ChatgptSchemaAuditFile -PathType Leaf)) {
        return $state
    }

    try {
        $audit = Get-Content -LiteralPath $ChatgptSchemaAuditFile -Raw | ConvertFrom-Json
        $baseline = $state.schema_propagation.baseline_audit
        $candidateSequence = $null
        $baselineSequence = $null
        $candidateObservedAtUnixMs = $null
        $baselineObservedAtUnixMs = $null
        try { $candidateSequence = [int64]$audit.sequence } catch { $candidateSequence = $null }
        try { $baselineSequence = [int64]$baseline.sequence } catch { $baselineSequence = $null }
        try { $candidateObservedAtUnixMs = [int64]$audit.observed_at_unix_ms } catch { $candidateObservedAtUnixMs = $null }
        try { $baselineObservedAtUnixMs = [int64]$baseline.observed_at_unix_ms } catch { $baselineObservedAtUnixMs = $null }

        $isNewAudit = $false
        $observationReason = $null
        if ($null -ne $candidateSequence -and $null -ne $baselineSequence) {
            $isNewAudit = $candidateSequence -gt $baselineSequence
            if ($isNewAudit) { $observationReason = 'sequence_advanced_after_pending' }
        } elseif ($null -ne $candidateObservedAtUnixMs -and $null -ne $baselineObservedAtUnixMs) {
            $isNewAudit = $candidateObservedAtUnixMs -gt $baselineObservedAtUnixMs
            if ($isNewAudit) { $observationReason = 'observed_at_unix_ms_advanced_after_pending' }
        } else {
            $stateAt = [datetime]::Parse([string]$state.at)
            $auditAt = [datetime]::Parse([string]$audit.timestamp)
            $isNewAudit = $auditAt.ToUniversalTime() -ge $stateAt.ToUniversalTime().AddSeconds(-1)
            if ($isNewAudit) { $observationReason = 'audit_timestamp_after_pending' }
        }

        if (-not $isNewAudit) {
            return $state
        }

        $expectedFingerprint = [string]$state.schema_propagation.expected_schema_fingerprint
        $observedFingerprint = [string]$audit.schema_fingerprint
        $matches = -not [string]::IsNullOrWhiteSpace($expectedFingerprint) -and $observedFingerprint -eq $expectedFingerprint
        $refreshStartedAt = Get-Date
        try { $refreshStartedAt = [datetime]::Parse([string]$state.at) } catch { $refreshStartedAt = Get-Date }
        try {
            if ($state.schema_propagation.refresh_started_at) {
                $refreshStartedAt = [datetime]::Parse([string]$state.schema_propagation.refresh_started_at)
            }
        } catch {
            try { $refreshStartedAt = [datetime]::Parse([string]$state.at) } catch { $refreshStartedAt = Get-Date }
        }
        $canary = Get-ChatgptConnectorCanaryCallAfter -NotBefore $refreshStartedAt

        $state.schema_propagation.tools_list_observed_after_refresh = $true
        $state.schema_propagation.canary_tools_call_observed_after_refresh = [bool]$canary.observed
        $state.schema_propagation.canary = $canary
        $state.schema_propagation.pending = $false
        $state.schema_propagation.audit_observation_reason = $observationReason
        $state.schema_propagation.observed_schema_fingerprint = $observedFingerprint
        $state.schema_propagation.schema_fingerprint_match = [bool]$matches
        $state.schema_propagation.audit = $audit
        $state.schema_propagation.ok = [bool]($matches -and $canary.observed)
        $state.schema_propagation.status = if ($matches -and $canary.observed) { 'CONNECTOR_SCHEMA_PROPAGATION_CONFIRMED' } elseif ($matches) { 'CONNECTOR_SCHEMA_PROPAGATION_CANARY_PENDING' } else { 'CHATGPT_SCHEMA_FINGERPRINT_MISMATCH' }
        $state.schema_propagation.pending = [bool]($state.schema_propagation.status -eq 'CONNECTOR_SCHEMA_PROPAGATION_CANARY_PENDING')
        $state.ok = [bool]($matches -and $canary.observed)
        $state.status = [string]$state.schema_propagation.status
        $state.resolved_from_pending = $true
        $state.resolved_at = (Get-Date).ToString('o')
        $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        return $state
    } catch {
        return $state
    }
}

function Test-ChatgptConnectorRefreshAcceptable {
    param([object]$Result)
    if (-not $Result) { return $false }
    return [bool]($Result.ok -eq $true -or $Result.status -eq 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING')
}

function Write-ConnectorRefreshTrace {
    param([Parameter(Mandatory = $true)][object]$Record)

    try {
        $json = $Record | ConvertTo-Json -Depth 12 -Compress
        Write-SafeLogLine -Path $ConnectorRefreshTraceFile -Text $json
    } catch {
        Write-SafeLogLine -Path $ConnectorRefreshTraceFile -Text (@{
            timestamp = (Get-Date).ToString('o')
            event = 'connector_refresh_trace_write_failed'
            error = Sanitize-Text $_.Exception.Message
            pid = $PID
        } | ConvertTo-Json -Depth 4 -Compress)
    }
}

function Get-RuntimeToolSurfaceReport {
    $expectedTools = Get-DefaultExpectedSurface
    try {
        $codexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
        $runtimeTools = @()
        if ($codexSmoke.authenticated_smoke -and $codexSmoke.authenticated_smoke.PSObject.Properties.Name -contains 'list_tools') {
            $runtimeTools = @($codexSmoke.authenticated_smoke.list_tools | Sort-Object -Unique)
        }
        $healthPayload = $null
        try { $healthPayload = $codexSmoke.authenticated_smoke.health.structuredContent } catch { $healthPayload = $null }
        $chatgptSchemaFingerprint = $null
        $buildFingerprint = $null
        $canonicalRegistryFingerprint = $null
        try { $chatgptSchemaFingerprint = [string]$healthPayload.consumers.chatgpt.schemaFingerprint } catch { $chatgptSchemaFingerprint = $null }
        try { $buildFingerprint = [string]$healthPayload.buildFingerprint } catch { $buildFingerprint = $null }
        try { $canonicalRegistryFingerprint = [string]$healthPayload.canonicalRegistryFingerprint } catch { $canonicalRegistryFingerprint = $null }
        return [pscustomobject]@{
            ok = $codexSmoke.ok -eq $true
            runtime_schema = [pscustomobject]@{
                source = 'authenticated MCP tool list + health runtime fingerprint'
                count = $runtimeTools.Count
                tools = $runtimeTools
                smoke_ok = $codexSmoke.ok
                chatgpt_schema_fingerprint = $chatgptSchemaFingerprint
                build_fingerprint = $buildFingerprint
                canonical_registry_fingerprint = $canonicalRegistryFingerprint
            }
            comparison = Compare-ToolSurface -ExpectedTools $expectedTools -RuntimeTools $runtimeTools
            smoke = $codexSmoke
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            runtime_schema = [pscustomobject]@{ source = 'authenticated MCP tool list + health runtime fingerprint'; count = 0; tools = @(); smoke_ok = $false; chatgpt_schema_fingerprint = $null; build_fingerprint = $null; canonical_registry_fingerprint = $null }
            comparison = [pscustomobject]@{ ok = $false; status = 'RUNTIME_TOOLS_UNAVAILABLE'; expected_count = $expectedTools.Count; runtime_count = 0; missing_count = $null; unexpected_count = $null; missing = @(); unexpected = @(); error = Sanitize-Text $_.Exception.Message }
        }
    }
}

function Invoke-ChatgptConnectorRefresh {
    param(
        [switch]$Startup
    )

    Ensure-Directories
    $correlationId = 'refresh-' + ([guid]::NewGuid().ToString('N'))
    $attemptStartedAt = Get-Date
    Write-ConnectorRefreshTrace ([pscustomobject]@{
        timestamp = $attemptStartedAt.ToString('o')
        event = 'connector_refresh_requested'
        correlation_id = $correlationId
        pid = $PID
        refresh_requested = $true
        startup_hook = [bool]$Startup
    })

    $uiRefreshTimeoutSeconds = if ($Startup) { 30 } else { 60 }
    $propagationTimeoutSeconds = 90
    if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_TIMEOUT_SECONDS) {
        $parsed = 0
        if ([int]::TryParse($env:CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_TIMEOUT_SECONDS, [ref]$parsed) -and $parsed -gt 0) {
            $uiRefreshTimeoutSeconds = $parsed
        }
    }

    if ($env:CONSOLE_MCP_CHATGPT_SCHEMA_PROPAGATION_TIMEOUT_SECONDS) {
        $parsed = 0
        if ([int]::TryParse($env:CONSOLE_MCP_CHATGPT_SCHEMA_PROPAGATION_TIMEOUT_SECONDS, [ref]$parsed) -and $parsed -gt 0) {
            $propagationTimeoutSeconds = $parsed
        }
    }

    $connectorName = if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_NAME) { $env:CONSOLE_MCP_CHATGPT_CONNECTOR_NAME.Trim() } else { 'console-mcp' }
    $connectorId = if ($env:CONSOLE_MCP_CHATGPT_CONNECTOR_ID) { $env:CONSOLE_MCP_CHATGPT_CONNECTOR_ID.Trim() } else { 'asdk_app_6a387987d2f881918ffe72c70002307c' }
    $ports = if ($env:CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS) { $env:CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS.Trim() } else { '9222,9223' }
    $scriptPath = Join-Path $Root 'tool\chatgpt-connector-refresh.mjs'
    $node = Get-NodeCommand
    $exitCode = 1
    $beforeAudit = $null
    $beforeAuditFileWriteUtc = $null
    if (Test-Path -LiteralPath $ChatgptSchemaAuditFile -PathType Leaf) {
        try {
            $beforeAudit = Get-Content -LiteralPath $ChatgptSchemaAuditFile -Raw | ConvertFrom-Json
            $beforeAuditFileWriteUtc = (Get-Item -LiteralPath $ChatgptSchemaAuditFile).LastWriteTimeUtc
        } catch {
            $beforeAudit = $null
            $beforeAuditFileWriteUtc = $null
        }
    }

    try {
        $output = & $node.Source $scriptPath --name $connectorName --connectorId $connectorId --ports $ports --timeout-sec $uiRefreshTimeoutSeconds 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        $output = @((Sanitize-Text $_.Exception.Message))
        $exitCode = 1
    }

    $raw = (($output | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $raw = '{"ok":false,"status":"empty-refresh-output"}'
    }

    Write-SafeLogLine -Path $ConnectorRefreshLogFile -Text $raw
    try {
        $parsedResult = $raw | ConvertFrom-Json
        $parsedResult | Add-Member -NotePropertyName at -NotePropertyValue (Get-Date).ToString('o') -Force
        $parsedResult | Add-Member -NotePropertyName correlation_id -NotePropertyValue $correlationId -Force
        $parsedResult | Add-Member -NotePropertyName exit_code -NotePropertyValue $exitCode -Force
        $parsedResult | Add-Member -NotePropertyName startup_hook -NotePropertyValue ([bool]$Startup) -Force
        $parsedResult | Add-Member -NotePropertyName state_file -NotePropertyValue $ConnectorRefreshStateFile -Force
        $runtimeSurface = Get-RuntimeToolSurfaceReport
        $parsedResult | Add-Member -NotePropertyName runtime_schema -NotePropertyValue $runtimeSurface.runtime_schema -Force
        $parsedResult | Add-Member -NotePropertyName runtime_schema_comparison -NotePropertyValue $runtimeSurface.comparison -Force

        $refreshStartedAt = Get-Date
        try {
            if ($parsedResult.refresh_click -and $parsedResult.refresh_click.at) {
                $refreshStartedAt = [datetime]::Parse([string]$parsedResult.refresh_click.at)
            }
        } catch { $refreshStartedAt = Get-Date }
        $chatgptAudit = $null
        $auditObservationReason = $null
        $propagationDeadline = (Get-Date).AddSeconds($propagationTimeoutSeconds)
        while ((Get-Date) -lt $propagationDeadline) {
            if (Test-Path -LiteralPath $ChatgptSchemaAuditFile -PathType Leaf) {
                try {
                    $candidate = Get-Content -LiteralPath $ChatgptSchemaAuditFile -Raw | ConvertFrom-Json
                    $candidateAt = [datetime]::Parse([string]$candidate.timestamp)
                    $candidateFileWriteUtc = (Get-Item -LiteralPath $ChatgptSchemaAuditFile).LastWriteTimeUtc
                    $candidateSequence = $null
                    $beforeSequence = $null
                    $candidateObservedAtUnixMs = $null
                    $beforeObservedAtUnixMs = $null
                    try { $candidateSequence = [int64]$candidate.sequence } catch { $candidateSequence = $null }
                    try { $beforeSequence = [int64]$beforeAudit.sequence } catch { $beforeSequence = $null }
                    try { $candidateObservedAtUnixMs = [int64]$candidate.observed_at_unix_ms } catch { $candidateObservedAtUnixMs = $null }
                    try { $beforeObservedAtUnixMs = [int64]$beforeAudit.observed_at_unix_ms } catch { $beforeObservedAtUnixMs = $null }

                    $isNewGeneration = $false
                    if ($null -ne $candidateSequence -and $null -ne $beforeSequence) {
                        $isNewGeneration = $candidateSequence -gt $beforeSequence
                        if ($isNewGeneration) { $auditObservationReason = 'sequence_advanced' }
                    } elseif ($null -ne $candidateObservedAtUnixMs -and $null -ne $beforeObservedAtUnixMs) {
                        $isNewGeneration = $candidateObservedAtUnixMs -gt $beforeObservedAtUnixMs
                        if ($isNewGeneration) { $auditObservationReason = 'observed_at_unix_ms_advanced' }
                    } elseif ($beforeAuditFileWriteUtc) {
                        $isNewGeneration = $candidateFileWriteUtc -gt $beforeAuditFileWriteUtc
                        if ($isNewGeneration) { $auditObservationReason = 'audit_file_write_time_advanced' }
                    } else {
                        $isNewGeneration = $candidateAt.ToUniversalTime() -ge $refreshStartedAt.ToUniversalTime().AddSeconds(-1)
                        if ($isNewGeneration) { $auditObservationReason = 'first_audit_after_refresh' }
                    }

                    if ($isNewGeneration -and $candidateAt.ToUniversalTime() -ge $refreshStartedAt.ToUniversalTime().AddSeconds(-1)) {
                        $chatgptAudit = $candidate
                        break
                    }
                } catch { $chatgptAudit = $null }
            }
            Start-Sleep -Milliseconds 500
        }
        $expectedFingerprint = [string]$runtimeSurface.runtime_schema.chatgpt_schema_fingerprint
        $observedFingerprint = if ($chatgptAudit -and $chatgptAudit.schema_fingerprint) { [string]$chatgptAudit.schema_fingerprint } else { $null }
        $schemaFetchConfirmed = [bool]($chatgptAudit -and -not [string]::IsNullOrWhiteSpace($observedFingerprint))
        $schemaFingerprintMatch = [bool]($schemaFetchConfirmed -and -not [string]::IsNullOrWhiteSpace($expectedFingerprint) -and $observedFingerprint -eq $expectedFingerprint)
        $uiVisible = [bool]($parsedResult.observed_schema -and $parsedResult.observed_schema.exposed -eq $true)
        $uiCatalogMatch = [bool]($parsedResult.schema_comparison -and $parsedResult.schema_comparison.ok -eq $true)
        $refreshClicked = [bool]($parsedResult.refresh_click -and $parsedResult.refresh_click.clicked -eq $true)
        $uiConfirmed = [bool]($parsedResult.refresh_click -and $parsedResult.refresh_click.ui_confirmed -eq $true)
        $uiConfirmation = if ($parsedResult.refresh_click) { [string]$parsedResult.refresh_click.ui_confirmation } else { $null }
        $uiConfirmationStrength = if ($parsedResult.refresh_click -and $parsedResult.refresh_click.ui_confirmation_strength) { [string]$parsedResult.refresh_click.ui_confirmation_strength } else { 'none' }
        $schemaAlreadyCurrent = [bool]($parsedResult.result -and [string]$parsedResult.result.status -eq 'CONNECTOR_REFRESH_SKIPPED_SCHEMA_CURRENT_LIGHTWEIGHT')
        $canary = Get-ChatgptConnectorCanaryCallAfter -NotBefore $refreshStartedAt
        # The authenticated server-side tools/list fingerprint is authoritative. ChatGPT's
        # settings DOM is diagnostic only: it may be collapsed, virtualized, lazily rendered, or
        # omitted by a UI revision even when ChatGPT fetched the correct schema.
        $propagationOk = [bool](($refreshClicked -or $schemaAlreadyCurrent) -and $uiConfirmed -and $schemaFetchConfirmed -and $schemaFingerprintMatch -and $canary.observed)
        $propagationStatus = if ($propagationOk) {
            if ($schemaAlreadyCurrent) { 'CONNECTOR_SCHEMA_PROPAGATION_ALREADY_CURRENT' } else { 'CONNECTOR_SCHEMA_PROPAGATION_CONFIRMED' }
        } elseif (-not $refreshClicked) {
            'CONNECTOR_REFRESH_NOT_CLICKED'
        } elseif (-not $uiConfirmed) {
            'CONNECTOR_REFRESH_CLICKED_UI_NOT_CONFIRMED'
        } elseif (-not $schemaFetchConfirmed) {
            'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING'
        } elseif (-not $schemaFingerprintMatch) {
            'CHATGPT_SCHEMA_FINGERPRINT_MISMATCH'
        } elseif (-not $canary.observed) {
            'CONNECTOR_SCHEMA_PROPAGATION_CANARY_PENDING'
        } else {
            'CONNECTOR_SCHEMA_PROPAGATION_UNCONFIRMED'
        }
        $proof = [pscustomobject]@{
            ok = $propagationOk
            status = $propagationStatus
            refresh_clicked = $refreshClicked
            ui_confirmed = $uiConfirmed
            ui_confirmation = $uiConfirmation
            ui_confirmation_strength = $uiConfirmationStrength
            tools_list_observed_after_refresh = $schemaFetchConfirmed
            canary_tools_call_observed_after_refresh = [bool]$canary.observed
            canary = $canary
            pending = [bool]($propagationStatus -in @('CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING', 'CONNECTOR_SCHEMA_PROPAGATION_CANARY_PENDING'))
            audit_observation_reason = $auditObservationReason
            refresh_started_at = $refreshStartedAt.ToUniversalTime().ToString('o')
            ui_refresh_timeout_seconds = $uiRefreshTimeoutSeconds
            propagation_timeout_seconds = $propagationTimeoutSeconds
            baseline_audit = $beforeAudit
            expected_schema_fingerprint = $expectedFingerprint
            observed_schema_fingerprint = $observedFingerprint
            schema_fingerprint_match = $schemaFingerprintMatch
            ui_catalog_visible = $uiVisible
            schema_already_current = $schemaAlreadyCurrent
            ui_catalog_matches_expected = $uiCatalogMatch
            audit_file = $ChatgptSchemaAuditFile
            audit = $chatgptAudit
        }
        $parsedResult | Add-Member -NotePropertyName schema_propagation -NotePropertyValue $proof -Force
        $parsedResult.ok = $propagationOk
        $parsedResult.status = $propagationStatus
        $attemptCompletedAt = Get-Date
        Write-ConnectorRefreshTrace ([pscustomobject]@{
            timestamp = $attemptCompletedAt.ToString('o')
            event = 'connector_refresh_completed'
            correlation_id = $correlationId
            pid = $PID
            refresh_requested = $true
            ui_refresh_action_observed = $refreshClicked
            connector_reconnect_observed = $uiConfirmed
            live_tools_list_observed = $schemaFetchConfirmed
            canary_tools_call_observed = [bool]$canary.observed
            propagation_confirmed = $propagationOk
            propagation_failed = -not $propagationOk
            status = $propagationStatus
            startup_hook = [bool]$Startup
            exit_code = $exitCode
            elapsed_ms = [int][math]::Max(0, ($attemptCompletedAt - $attemptStartedAt).TotalMilliseconds)
            expected_schema_fingerprint = $expectedFingerprint
            observed_schema_fingerprint = $observedFingerprint
            schema_fingerprint_match = $schemaFingerprintMatch
            audit_observation_reason = $auditObservationReason
        })
        $parsedResult | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        $terminalFailure = $parsedResult.status -in @(
            'CONNECTOR_REFRESH_NOT_CLICKED',
            'CHATGPT_SCHEMA_FINGERPRINT_MISMATCH',
            'CONNECTOR_SCHEMA_PROPAGATION_UNCONFIRMED'
        )
        if (-not $Startup -and $terminalFailure) {
            throw "ChatGPT connector refresh failed: $($parsedResult.status)"
        }
        return ($parsedResult | ConvertTo-Json -Depth 30)
    } catch {
        if ($_.Exception.Message -like 'ChatGPT connector refresh failed:*') {
            throw
        }
        $fallback = [pscustomobject]@{
            ok = $false
            status = 'refresh-output-unparseable'
            at = (Get-Date).ToString('o')
            correlation_id = $correlationId
            exit_code = $exitCode
            startup_hook = [bool]$Startup
            state_file = $ConnectorRefreshStateFile
            raw = $raw
            error = Sanitize-Text $_.Exception.Message
        }
        $attemptCompletedAt = Get-Date
        Write-ConnectorRefreshTrace ([pscustomobject]@{
            timestamp = $attemptCompletedAt.ToString('o')
            event = 'connector_refresh_completed'
            correlation_id = $correlationId
            pid = $PID
            refresh_requested = $true
            ui_refresh_action_observed = $false
            connector_reconnect_observed = $false
            live_tools_list_observed = $false
            propagation_confirmed = $false
            propagation_failed = $true
            status = $fallback.status
            startup_hook = [bool]$Startup
            exit_code = $exitCode
            elapsed_ms = [int][math]::Max(0, ($attemptCompletedAt - $attemptStartedAt).TotalMilliseconds)
            error = $fallback.error
        })
        $fallback | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConnectorRefreshStateFile -Encoding utf8
        if (-not $Startup) {
            throw "ChatGPT connector refresh failed: $($fallback.error)"
        }
        return ($fallback | ConvertTo-Json -Depth 10)
    }
}

function Wait-PublicSmokeReady {
    param(
        [int]$TimeoutSeconds = 30,
        [int]$IntervalSeconds = 2
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    $stableCount = 0

    while ((Get-Date) -lt $deadline) {
        $last = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet
        if ($last.ok -eq $true) {
            $stableCount++
            if ($stableCount -ge 2) {
                $last | Add-Member -NotePropertyName stable_success_count -NotePropertyValue $stableCount -Force
                return $last
            }
        } else {
            $stableCount = 0
        }

        Start-Sleep -Seconds $IntervalSeconds
    }

    throw ("public smoke did not become stably ready within {0} seconds. Last result: {1}" -f $TimeoutSeconds, (($last | ConvertTo-Json -Depth 8 -Compress)))
}

