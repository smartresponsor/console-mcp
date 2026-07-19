function Invoke-ChatgptConnectorRefresh {
    param(
        [switch]$Startup
    )

    Ensure-Directories

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
        # The authenticated server-side tools/list fingerprint is authoritative. ChatGPT's
        # settings DOM is diagnostic only: it may be collapsed, virtualized, lazily rendered, or
        # omitted by a UI revision even when ChatGPT fetched the correct schema.
        $propagationOk = [bool](($refreshClicked -or $schemaAlreadyCurrent) -and $uiConfirmed -and $schemaFetchConfirmed -and $schemaFingerprintMatch)
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
            pending = [bool]($propagationStatus -eq 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING')
            audit_observation_reason = $auditObservationReason
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
            exit_code = $exitCode
            startup_hook = [bool]$Startup
            state_file = $ConnectorRefreshStateFile
            raw = $raw
            error = Sanitize-Text $_.Exception.Message
        }
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

